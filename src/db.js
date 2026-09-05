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
import { computeLoss } from "./engine/loss.ts";

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
  async importLocal(bundle, opts) { return importBundle(this, bundle, opts); }
  async funnelLocal(opts) { return runFunnel(this, opts); }
  /** 員工效能／流失原因的三段分析：角色（歸因）→ 行為特徵（要先有角色）→ 流失原因。全部規則、可重跑。 */
  async analyzeLocal(opts) {
    const t0 = Date.now();
    const roles = await computeRoles(this, { leadIds: opts.leadIds });
    const behaviors = await computeBehaviors(this, { now: opts.now, leadIds: opts.leadIds });
    const loss = await computeLoss(this, { now: opts.now, leadIds: opts.leadIds });
    return { roles, behaviors, loss, ms: Date.now() - t0 };
  }
  /** 給評測腳本：每個 lead 的角色／流失原因／行為特徵，附對話外部鍵（CV{n} ↔ 標準答案 L{n}） */
  async analyzeDumpLocal() {
    const rows = await this.all(`SELECT l.id, l.outcome, cv.external_id AS conv_key, la.primary_reason, la.secondary_reason, la.confidence AS loss_conf, la.driver, la.stage, la.status AS loss_status, b.features
      FROM leads l LEFT JOIN conversations cv ON cv.lead_id = l.id LEFT JOIN loss_analyses la ON la.lead_id = l.id LEFT JOIN behaviors b ON b.lead_id = l.id ORDER BY l.id`);
    const roles = await this.all("SELECT r.lead_id, u.name AS staff, r.role, r.confidence FROM lead_roles r JOIN users u ON u.id = r.user_id");
    return { rows, roles };
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
