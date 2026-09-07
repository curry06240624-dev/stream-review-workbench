/**
 * AppDB —— 整個系統唯一的資料庫（Durable Object + SQLite）。
 *
 * 搬家路線：DO SQLite 與 D1 同為 SQLite 方言。正式上線搬到公司帳號時，
 * 把 SCHEMA 原封餵給 `wrangler d1 execute`，把本檔的 exec 換成 D1 prepare 即可。
 */
import { DurableObject } from "cloudflare:workers";
import { migrate } from "./model/schema.ts";
import { importBundle } from "./adapters/import.ts";
import { runFunnel } from "./engine/funnel.ts";
import { computeAnalytics } from "./engine/analytics.ts";
import { deriveInsights, persistInsights } from "./engine/insights.ts";
import { gemini } from "./engine/ai.ts";
import { computeRoles } from "./engine/attribution.ts";
import { computeBehaviors } from "./engine/behavior.ts";
import { computeLoss, lossAggregate } from "./engine/loss.ts";
import { computeGrades } from "./engine/grade.ts";
import { computeStaffReport } from "./engine/staff.ts";
import { buildCoachingPlan, computeDecisions, metricSnapshot, actionProgress } from "./engine/coaching.ts";
import { ingestPosts, matchReport, applyReport, unapplyReport, reconcileSummary } from "./engine/reconcile.ts";
import { parseLineExport } from "./engine/posts.ts";
import { syncSheetDeals } from "./engine/sheetdeals.ts";
import { vehicleKey, VANISHED_TEXT } from "./engine/csv.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'agent',     -- admin | operator | agent
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  iter       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS failed_logins (
  email TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  until TEXT
);

/* ══ 訊息中心 ═══════════════════════════════════════════════════
   權限模型照瑋瑋電話裡描述的：運營指派對話給訊息手，被指派者獨占，
   同層級互不可見，管理職全見。

   ⚠️ 身分鍵的設計是這套系統勝過 Super 8 的地方：
   LINE 的 userId 是綁「單一官方帳號」的（官方 FAQ 查證過），換帳號就對不回來。
   所以 contacts 的主軸是 phone（自有身分鍵），channel_uid 只是某個渠道的別名。
   一個人可以有多個 channel_uid（LINE 換號、FB、IG），但 phone 只有一組。 */
CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name  TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',      -- 自有身分鍵，跨渠道跨帳號都對得回來
  grade         TEXT NOT NULL DEFAULT 'C',     -- S | A | B | C（C＝未持續互動）
  note          TEXT NOT NULL DEFAULT '',
  blocked       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id),
  channel     TEXT NOT NULL,                   -- line | fb | ig
  channel_uid TEXT NOT NULL,                   -- 該渠道的 ID，換官方帳號就會變
  source      TEXT NOT NULL DEFAULT '',        -- 獲客渠道：meta | ig | line_search…
  UNIQUE(channel, channel_uid)
);
CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id),
  channel         TEXT NOT NULL DEFAULT 'line',
  assigned_to     INTEGER REFERENCES users(id),  -- NULL＝未指派，在運營的收件匣
  status          TEXT NOT NULL DEFAULT 'open',  -- open | closed
  last_message_at TEXT NOT NULL,
  unread          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  direction       TEXT NOT NULL,                 -- in（客戶）| out（我們）
  sender_user_id  INTEGER REFERENCES users(id),  -- out 才有
  text            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
/* 指派紀錄：誰把誰的對話轉給誰。瑋瑋要的可稽核性，Super 8 沒有給他這個。 */
CREATE TABLE IF NOT EXISTS assignment_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  from_user_id    INTEGER,
  to_user_id      INTEGER,
  by_user_id      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL
);
/* 可設定的營運參數。SLA 目標放這裡而不是寫死在程式裡 ——
   「多久要回」是老闆的生意決定，不是工程師的常數。 */
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('sla_minutes', '30');

/* ══ 自動回覆 ══════════════════════════════════════════════════
   規則本身很笨（關鍵字子字串比對），這是刻意的 ——
   運營要能自己看規則就預測得到機器人會說什麼，猜不到的規則沒人敢開。
   autoreply_log 存的是「哪條規則在哪通對話回過」，用來擋重複，也用來稽核。 */
CREATE TABLE IF NOT EXISTS autoreplies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  keywords   TEXT NOT NULL,                  -- 逗號分隔
  reply      TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  hits       INTEGER NOT NULL DEFAULT 0,     -- 命中次數：規則有沒有用，看這個
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS autoreply_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  rule_id         INTEGER NOT NULL REFERENCES autoreplies(id),
  matched_keyword TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arlog ON autoreply_log(conversation_id, rule_id, id);

CREATE INDEX IF NOT EXISTS idx_conv_assigned ON conversations(assigned_to, last_message_at);
CREATE INDEX IF NOT EXISTS idx_msg_conv      ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_cc_contact    ON contact_channels(contact_id);
`;

/* 舊的直播覆盤模組已移除（見 git 歷史 commit 8402e70）。
   本機開發資料庫可能還留著那幾張表，留著無害，不會被任何查詢碰到。 */

export class AppDB extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    migrate(this.sql);            // 新表與新欄位（冪等），見 src/model/schema.ts
  }

  /** 全部列。參數用 ? 佔位。 */
  all(query, ...params) {
    return this.sql.exec(query, ...params).toArray();
  }

  /** 第一列或 null。 */
  first(query, ...params) {
    const rows = this.sql.exec(query, ...params).toArray();
    return rows.length ? rows[0] : null;
  }

  /** 寫入；回 { lastRowId }。 */
  run(query, ...params) {
    const cur = this.sql.exec(query, ...params);
    cur.toArray();                     // 讓語句真的執行完
    const row = this.sql.exec("SELECT last_insert_rowid() AS id").toArray()[0];
    return { lastRowId: row ? row.id : null };
  }

  /* ── 重活在 DO 裡面跑 ──
     Worker→DO 每一次查詢都算一次 subrequest（免費方案一次呼叫上限 1000）；
     匯入 1,344 則訊息、或跑 144 個 lead 的漏斗，在 Worker 端會直接爆
     「Too many API requests by single Worker invocation」。搬進 DO 就是本地呼叫，沒有這個上限。 */
  /* ── 讀取快取：DO 免費方案每天 500 萬列讀取；員工報表一次讀幾萬列、每頁又叫好幾次（2026-09-05 就撞到
        「Exceeded allowed rows read」）。同一小時、同參數直接回記憶體快取；資料一改就清掉。 ── */
  async cached(key, ttlMs, fn, fresh = false) {
    this._cache ??= new Map();
    if (!fresh) {
      const hit = this._cache.get(key); if (hit && hit.exp > Date.now()) return hit.value;
      // 第二層：SQLite 持久快取。DO 閒置被回收、或重新部署，記憶體快取就沒了；5 萬個 lead 的決策中心冷算要幾十秒，展示時不能等
      const row = this.first("SELECT value, exp FROM cache_json WHERE key = ?", key);
      if (row && Number(row.exp) > Date.now()) { try { const value = JSON.parse(row.value); this._cache.set(key, { value, exp: Number(row.exp) }); return value; } catch { /* 壞掉就重算 */ } }
    }
    const value = await fn(); const exp = Date.now() + ttlMs;
    this._cache.set(key, { value, exp });
    try { this.run("INSERT OR REPLACE INTO cache_json (key, value, exp) VALUES (?,?,?)", key, JSON.stringify(value), exp); } catch { /* 存不進去就只留記憶體 */ }
    return value;
  }
  /** 資料一改（匯入／漏斗／分析／配對／行動）就清兩層快取 */
  bust() { this._cache = new Map(); try { this.run("DELETE FROM cache_json"); } catch { /* 表還沒建好 */ } }
  /** 快取鍵的時間桶：一天一桶。底層資料只有 pipeline 會改（改了就 bust），一天內只差期間邊界往前挪幾小時 */
  bucket(to) { return to ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); }   // 台灣日期：桶在台灣 00:00 換，換完 cron 馬上暖
  reportCached(days, to, fresh = false) { return this.cached(`report:${days ?? 30}:${this.bucket(to)}`, 24 * 60 * 60_000, () => computeStaffReport(this, { days, to }), fresh); }
  async importLocal(bundle, opts) { this.bust(); return importBundle(this, bundle, opts); }
  /** 分析數字（總覽／成交／漏斗／需要注意都靠它）：每頁載入會叫好幾次，每次讀幾萬列 → 同參數同一小時回快取 */
  analyticsLocal(opts) { return this.cached(`analytics:${opts.days ?? 7}:${this.bucket(opts.to)}`, 24 * 60 * 60_000, () => computeAnalytics(this, { to: opts.to, days: opts.days }), !!opts.fresh); }
  async funnelLocal(opts) { this.bust(); return runFunnel(this, opts); }
  /** 員工效能／流失原因的三段分析：角色（歸因）→ 行為特徵（要先有角色）→ 流失原因。全部規則、可重跑。 */
  async analyzeLocal(opts) {
    this.bust();
    const t0 = Date.now();
    const roles = await computeRoles(this, { leadIds: opts.leadIds });
    const behaviors = await computeBehaviors(this, { now: opts.now, leadIds: opts.leadIds });
    const loss = await computeLoss(this, { now: opts.now, leadIds: opts.leadIds });
    const grades = await computeGrades(this, { now: opts.now, leadIds: opts.leadIds });
    return { roles, behaviors, loss, grades, ms: Date.now() - t0 };
  }
  /** SABC 分級單獨重算（規則改了不用整套分析重跑） */
  async gradesLocal(opts) { this.bust(); return computeGrades(this, opts); }
  /* ── 員工效能／流失原因／教練／決策卡／管理行動：重活一律在這裡跑 ── */
  async staffLocal(opts) { return this.reportCached(opts.days, opts.to, !!opts.fresh); }
  async staffProfileLocal(opts) {
    const report = await this.reportCached(opts.days, opts.to);
    const s = report.staff.find((x) => x.id === opts.id); if (!s) return null;
    const last = await this.first("SELECT content, model, created_at FROM coaching_plans WHERE staff_id = ? ORDER BY id DESC LIMIT 1", opts.id);
    let plan = null; if (last && !opts.refresh) { try { plan = JSON.parse(String(last.content)); plan.model = last.model; } catch { plan = null; } }
    if (!plan) plan = await buildCoachingPlan(this, report, opts.id, opts.now);
    const leads = await this.all(`SELECT l.id, l.stage, l.outcome, l.opened_at, l.closed_at, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact, COALESCE(v.brand||' '||v.model,'') AS vehicle,
        la.primary_reason, la.driver, la.stage AS lost_stage, d.gross_profit, d.sale_price, d.cost_source, d.gp_is_estimate
      FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN vehicles v ON v.id = l.vehicle_id LEFT JOIN loss_analyses la ON la.lead_id = l.id LEFT JOIN deals d ON d.lead_id = l.id AND d.status = 'sold'
      WHERE l.staff_id = ? AND l.opened_at >= ? AND l.opened_at < ? ORDER BY l.opened_at DESC LIMIT 60`, opts.id, report.period.from, report.period.to);
    const roles = await this.all(`SELECT r.role, COUNT(*) AS n FROM lead_roles r JOIN leads l ON l.id = r.lead_id WHERE r.user_id = ? AND l.opened_at >= ? AND l.opened_at < ? GROUP BY r.role`, opts.id, report.period.from, report.period.to);
    const ranks = report.rankings.map((r) => { const row = r.rows.find((x) => x.staff_id === opts.id); return { key: r.key, label: r.label, rank: row?.rank ?? null, display: row?.display ?? "—", n: row?.n ?? 0, ok: !!row?.ok, of: r.rows.filter((x) => x.ok).length }; });
    return { staff: s, issues: report.issues[opts.id] ?? [], rankings: ranks, team: report.team, top_ids: report.compare.top_ids, watch_ids: report.compare.watch_ids, plan, leads, roles,
      pairs: report.pairs.filter((p) => p.a_id === opts.id || p.b_id === opts.id), patterns: report.patterns.filter((p) => p.staff.some((x) => x.id === opts.id)).map((p) => ({ key: p.key, label: p.label })), period: report.period, associations: report.associations };
  }
  async coachingLocal(opts) { const report = await this.reportCached(opts.days, opts.to); return buildCoachingPlan(this, report, opts.id, opts.now); }
  async decisionsLocal(opts) { const report = await this.reportCached(opts.days, opts.to, !!opts.fresh); return this.cached(`decisions:${opts.days}:${this.bucket(opts.to)}`, 24 * 60 * 60_000, async () => { const t0 = Date.now(); const cards = await computeDecisions(this, report, opts.now); return { cards, period: report.period, top: report.top.slice(0, 3), watch: report.watch.slice(0, 2), timings: { ...(report.timings ?? {}), decisions: Date.now() - t0 } }; }, !!opts.fresh); }
  async lossAggLocal(opts) { return lossAggregate(this, opts); }
  /* ── 待確認配對：成交群「送貨囉」貼文 → 車／客戶／業務 → 成交帳本；接待群 → 到店；估車群 → 估車 ── */
  async reconcileLocal(opts) { return reconcileSummary(this, opts); }
  async ingestGroupLocal(opts) {
    this.bust();
    const posts = Array.isArray(opts.posts) && opts.posts.length ? opts.posts : parseLineExport(String(opts.text || ""));
    const r = await ingestPosts(this, posts, { kind: opts.kind || "auto", source_system: opts.source_system || "line_export", now: opts.now });
    return { ...r, unparsed: r.unparsed.slice(0, 20), unmatched_posts: r.unmatched_posts.slice(0, 20) };
  }
  async reportActionLocal(opts) {
    this.bust();
    if (opts.action === "confirm") return applyReport(this, opts.id, opts.overrides || {}, opts.by, opts.now, "confirmed");
    if (opts.action === "reject") { await unapplyReport(this, opts.id, "rejected", opts.by, opts.now); return { ok: true }; }
    if (opts.action === "undo") { await unapplyReport(this, opts.id, "suggested", opts.by, opts.now); return { ok: true }; }
    if (opts.action === "rematch") {
      await this.run("UPDATE deal_reports SET match_status = 'suggested' WHERE id = ? AND match_status IN ('unmatched','suggested','rejected')", opts.id);
      await matchReport(this, opts.id, opts.now);
      return { ok: true };
    }
    throw new Error("沒有這個動作");
  }
  /* ── 資料上傳箱：中繼資料在這裡，檔案本體在 KV（Worker 端處理）── */
  async documentsLocal() {
    const rows = await this.all("SELECT id, name, size, mime, kind, note, uploaded_by, uploaded_at, status, result, processed_at, sha FROM documents WHERE deleted_at IS NULL ORDER BY uploaded_at DESC LIMIT 300");
    return rows.map((r) => { let result = {}; try { result = JSON.parse(r.result || "{}"); } catch {} return { ...r, result }; });
  }
  async documentInsertLocal(d) {
    const dup = await this.first("SELECT id, name FROM documents WHERE sha = ? AND deleted_at IS NULL", d.sha);
    if (dup) return { id: Number(dup.id), duplicate: true, dupName: dup.name };
    const r = await this.run("INSERT INTO documents (name, size, mime, kind, note, uploaded_by, uploaded_at, status, sha, kv_key) VALUES (?,?,?,?,?,?,?,?,?,?)", d.name, d.size, d.mime, d.kind, d.note, d.uploaded_by, d.uploaded_at, "uploaded", d.sha, d.kv_key);
    return { id: r.lastRowId, duplicate: false };
  }
  async documentUpdateLocal(id, patch) {
    const sets = [], args = [];
    for (const k of ["kind", "note", "status", "result", "processed_at", "deleted_at"]) if (patch[k] !== undefined) { sets.push(`${k} = ?`); args.push(typeof patch[k] === "object" && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]); }
    if (!sets.length) return { ok: true };
    await this.run(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`, ...args, id);
    return { ok: true };
  }
  async documentGetLocal(id) { return this.first("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL", id); }
  /** 車源表 CSV → vehicles：有車牌的以車牌更新，沒有的用「廠牌 車型 年份 顏色」找，都找不到就新增 */
  async vehiclesUpsertLocal(opts) {
    this.bust(); let inserted = 0, updated = 0;
    for (const v of opts.vehicles) {
      let ex = v.plate_norm ? await this.first("SELECT id FROM vehicles WHERE plate_norm = ?", v.plate_norm) : null;
      if (!ex && !v.plate_norm) ex = await this.first("SELECT id FROM vehicles WHERE brand = ? AND model = ? AND COALESCE(year,0) = COALESCE(?,0) AND color = ? AND plate_norm = ''", v.brand, v.model, v.year, v.color);
      const costKnown = v.cost == null ? 0 : 1;
      if (ex) {
        await this.run(`UPDATE vehicles SET brand = COALESCE(NULLIF(?,''), brand), model = COALESCE(NULLIF(?,''), model), year = COALESCE(?, year), color = COALESCE(NULLIF(?,''), color), mileage_km = COALESCE(?, mileage_km),
            list_price = COALESCE(?, list_price), cost = CASE WHEN ? = 1 THEN ? ELSE cost END, cost_known = CASE WHEN ? = 1 THEN 1 ELSE cost_known END, stock_status = ?, status_text = ?, stock_in_at = COALESCE(?, stock_in_at), cert = COALESCE(NULLIF(?,''), cert), trim = COALESCE(NULLIF(?,''), trim), sell_price = COALESCE(?, sell_price), plate = COALESCE(NULLIF(?,''), plate), plate_norm = COALESCE(NULLIF(?,''), plate_norm) WHERE id = ?`,
          v.brand, v.model, v.year, v.color, v.mileage_km, v.list_price, costKnown, v.cost ?? 0, costKnown, v.stock_status, v.status_text, v.stock_in_at, v.cert, v.trim, v.sell_price, v.plate, v.plate_norm, Number(ex.id));
        updated++;
      } else {
        await this.run(`INSERT INTO vehicles (brand, model, year, body_type, list_price, cost, cost_known, stock_status, external_id, plate, plate_norm, color, trim, mileage_km, stock_in_at, cert, sell_price, source, peer_dealer, status_text)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, v.brand || "", v.model || "", v.year, "", v.list_price ?? 0, v.cost ?? 0, costKnown, v.stock_status, `sheet:${v.plate_norm || `${v.brand}-${v.model}-${v.year ?? ""}-${v.color}`}`, v.plate, v.plate_norm, v.color, v.trim, v.mileage_km, v.stock_in_at, v.cert, v.sell_price, v.stock_status === "peer" ? "peer" : "stock", "", v.status_text);
        inserted++;
      }
    }
    // 車源表是「現在在庫」清單：賣掉的車會被刪掉。跟上一份比，消失的車推定已交車（車回到表上，sheetdeals 會撤銷）
    const vanished = [];
    if (Array.isArray(opts.prevKeys) && opts.prevKeys.length) {
      const nowKeys = new Set(opts.vehicles.map(vehicleKey));
      for (const k of opts.prevKeys.filter((x) => !nowKeys.has(x))) {
        const row = await this.first(`SELECT id, brand, model, plate, stock_status FROM vehicles WHERE source = 'stock' AND stock_status IN ('in_stock','reserved')
          AND (plate_norm = ? OR (plate_norm = '' AND LOWER(REPLACE(brand || '|' || model || '|' || COALESCE(year,'') || '|' || color, ' ', '')) = ?))`, k, k);
        if (!row) continue;
        await this.run("UPDATE vehicles SET stock_status = 'sold', status_text = ? WHERE id = ?", VANISHED_TEXT, row.id);
        vanished.push({ id: row.id, plate: row.plate, name: `${row.brand} ${row.model}`, was: row.stock_status });
      }
    }
    const sheet = await syncSheetDeals(this, { now: opts.now });
    return { inserted, updated, total: opts.vehicles.length, sheet_deals: sheet, vanished };
  }
  /** 上一份處理過的車源表（不含這一份），拿來比對消失的車 */
  async prevSheetDocLocal(currentId) {
    return this.first("SELECT id, name, kv_key FROM documents WHERE kind = 'sheet_csv' AND status = 'parsed' AND deleted_at IS NULL AND id <> ? ORDER BY processed_at DESC, id DESC LIMIT 1", currentId);
  }
  /** 車源表 售出／收訂 → 成交／收訂中（重跑用；匯入 bundle 與上傳車源表時會自動跑） */
  async sheetDealsSyncLocal(opts) { this.bust(); return syncSheetDeals(this, { now: opts.now }); }
  /** 會計月成本表 → deals.cost（正式成本，cost_source='accounting'）：車號＋成交日 ±3 天 */
  async accountingCostLocal(opts) {
    this.bust(); let matched = 0; const unmatched = [];
    for (const r of opts.rows) {
      if (r.cost == null) { unmatched.push({ plate: r.plate, why: "沒有成本" }); continue; }
      const dateSql = r.closed_at ? "AND ABS(julianday(d.closed_at) - julianday(?)) <= 3" : "";
      const args = r.closed_at ? [r.plate_norm, r.plate_norm, r.closed_at, r.closed_at] : [r.plate_norm, r.plate_norm];
      const d = await this.first(`SELECT d.id, d.sale_price FROM deals d LEFT JOIN vehicles v ON v.id = d.vehicle_id
          WHERE d.status = 'sold' AND (UPPER(REPLACE(REPLACE(d.plate,'-',''),' ','')) = ? OR v.plate_norm = ?) ${dateSql}
          ORDER BY ${r.closed_at ? "ABS(julianday(d.closed_at) - julianday(?))" : "d.closed_at DESC"} LIMIT 1`, ...args);
      if (!d) { unmatched.push({ plate: r.plate, why: r.closed_at ? "找不到這台車在成交日 ±3 天的成交" : "找不到這台車的成交" }); continue; }
      const price = r.sale_price ?? Number(d.sale_price);
      await this.run("UPDATE deals SET cost = ?, gross_profit = ?, cost_source = 'accounting', gp_is_estimate = 0, sale_price = ? WHERE id = ?", r.cost, price - r.cost, price, Number(d.id));
      matched++;
    }
    return { matched, unmatched_n: unmatched.length, unmatched: unmatched.slice(0, 20), total: opts.rows.length };
  }
  /** 重新配對所有還沒確認的貼文（例如補了暱稱或車源表之後） */
  async rematchAllLocal(opts) {
    this.bust();
    const rows = await this.all("SELECT id FROM deal_reports WHERE match_status IN ('unmatched','suggested')");
    for (const r of rows) await matchReport(this, Number(r.id), opts.now);
    return { rematched: rows.length };
  }
  async baselineLocal(opts) { const report = await this.reportCached(opts.days ?? 30, undefined); return metricSnapshot(report, opts.metric_key, opts.staff_id ?? null); }
  async progressLocal(opts) { const a = await this.first("SELECT * FROM actions WHERE id = ?", opts.id); if (!a) return null; return this.cached(`progress:${opts.id}:${this.bucket()}`, 24 * 60 * 60_000, () => actionProgress(this, a, opts.now)); }
  /** 給評測腳本：每個 lead 的角色／流失原因／行為特徵，附對話外部鍵（CV{n} ↔ 標準答案 L{n}） */
  async analyzeDumpLocal() {
    const rows = await this.all(`SELECT l.id, l.outcome, cv.external_id AS conv_key, la.primary_reason, la.secondary_reason, la.confidence AS loss_conf, la.driver, la.stage, la.status AS loss_status, b.features
      FROM leads l LEFT JOIN conversations cv ON cv.lead_id = l.id LEFT JOIN loss_analyses la ON la.lead_id = l.id LEFT JOIN behaviors b ON b.lead_id = l.id ORDER BY l.id`);
    const roles = await this.all("SELECT r.lead_id, u.name AS staff, r.role, r.confidence FROM lead_roles r JOIN users u ON u.id = r.user_id");
    const reports = await this.all(`SELECT r.id, r.reported_at, r.reported_by, r.match_status, r.match_confidence, r.lead_id, cv.external_id AS conv_key, v.external_id AS vehicle_key
      FROM deal_reports r LEFT JOIN conversations cv ON cv.lead_id = r.lead_id LEFT JOIN vehicles v ON v.id = r.vehicle_id`);
    return { rows, roles, reports };
  }
  /** AI 連線測試：從 DO 端打一次 Gemini（診斷用；正式的 AI 呼叫不走這裡） */
  async aiProbe(ai) {
    const t0 = Date.now();
    try { await gemini(ai || this.env, '只回傳 JSON {"ok":true}'); return { ok: true, ms: Date.now() - t0, has_key: !!(ai || this.env).GEMINI_API_KEY }; }
    catch (e) { return { ok: false, ms: Date.now() - t0, has_key: !!(ai || this.env).GEMINI_API_KEY, error: String(e && e.message || e) }; }
  }
  /** 洞察的決定性部分（分析 → 規則推導 → 落庫含證據）。AI 敘事留在 Worker 端做：
      DO 被釘在某個機房，從那裡打 Gemini 會被拒「User location is not supported」（2026-09-04 實測），Worker 端從台灣打就正常。 */
  async insightsLocal(opts) {
    this.bust();
    const at = opts.now;
    const a = await computeAnalytics(this, { to: opts.to, days: opts.days });
    const cands = deriveInsights(a);
    const { ids } = await persistInsights(this, cands, a, at);
    /* 一次只有一組「現行」洞察：新一輪成立後，其他仍為 0 的舊洞察全部標 dismissed=2（被取代），
       不然總覽會同時出現 7 天版與 14 天版的同一張卡。1＝使用者駁回、2＝被取代；證據列不動，舊的 /insights/:id 還是打得開。 */
    if (ids.length) await this.run(`UPDATE insights SET dismissed = 2 WHERE dismissed = 0 AND id NOT IN (${ids.map(() => "?").join(",")})`, ...ids);
    return { analytics: a, candidates: cands.length, persisted: ids.length };
  }
}
