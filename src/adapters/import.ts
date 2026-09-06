/**
 * 匯入 NormalizedBundle → 資料庫。
 *
 * 這是所有來源的共同入口：模擬器、Super 8 瀏覽器擷取、瑋瑋的表、LINE 群組匯出、之後的 API，
 * 全部先變成 bundle 再走這裡。系統其他部分不知道也不該知道資料從哪來。
 *
 * 用字串 key 互相參照，這裡換成 id。同一個 bundle 重匯不會重複：
 * source_records 以 (source_system, entity, external_id) 唯一。
 *
 * 2026-09-05 真實資料流（docs/DATA_FLOW.md）：
 *   - 員工的名字在各系統不一樣（LINE 暱稱／Super 8／車源表）：aliases 全部進 staff_aliases，之後對名字一律經過它
 *   - 車輛對齊車源表；同行的車沒成本 → cost_known=0
 *   - 訊息帶 via；對話的涵蓋程度沒給就用規則推（客戶提到電話、只有客戶訊息）
 *   - 證件照片（行照、身分證）永遠不入庫：訊息文字替換成「[證件照片，已略過]」
 *   - 成交群／估車群貼文原文最後才處理（要先有車與客戶才能配對）
 */
import type { BundleMessage, NormalizedBundle } from "../model/bundle.ts";
import { createUser } from "../auth.js";
import { normalizePlate } from "../engine/posts.ts";
import { ingestPosts } from "../engine/reconcile.ts";
import { runFunnel } from "../engine/funnel.ts";

type Row = Record<string, unknown>;
export interface DbLike {
  all(q: string, ...p: unknown[]): Promise<Row[]>;
  first(q: string, ...p: unknown[]): Promise<Row | null>;
  run(q: string, ...p: unknown[]): Promise<{ lastRowId: number }>;
}

export interface ImportReport {
  source_system: string;
  reset: boolean;
  counts: Record<string, number>;
  skipped: Record<string, number>;
  warnings: string[];
  posts?: { deal_reports: number; auto: number; suggested: number; unmatched: number; appraisals: number; unparsed: number };
}

/** 清掉資料表，但保留帳號、工作階段、設定、自動回覆規則 */
const DATA_TABLES = [
  "evidence", "actions", "insights", "briefs", "lead_roles", "loss_analyses", "behaviors", "coaching_plans", "funnel_events",
  "deal_reports", "appraisals", "group_posts", "visits", "appointments",
  "deals", "leads", "autoreply_log", "messages", "assignment_log", "conversations",
  "contact_channels", "contacts", "vehicles", "source_records", "teams", "staff_aliases",
];

const MOCK_STAFF_PASSWORD = "test-pass-123";   // 模擬員工的密碼；真員工帳號另外建

/* ── 證件照片與個資：匯入時就抹掉 ── */
const RE_ID_PHOTO = /行照|身分證|身份證|證件|駕照|存摺|健保卡/;
const RE_ID_NUMBER = /[A-Z][12]\d{8}/g;                     // 身分證字號
const RE_PHONE = /09\d{2}[- ]?\d{3}[- ]?\d{3}/g;
export function scrubMessage(m: BundleMessage): { text: string; type: string; note: string } {
  const type = m.type ?? "text";
  if (type !== "text" && RE_ID_PHOTO.test(m.text)) return { text: "[證件照片，已略過]", type, note: "id_photo" };
  let text = m.text.replace(RE_ID_NUMBER, "[身分證字號已抹掉]");
  if (m.role === "customer") text = text.replace(RE_PHONE, "[電話已抹掉]");
  return { text, type, note: "" };
}

/* ── 對話涵蓋程度：沒給就推 ── */
const RE_CALL_PAST = /電話(裡|中)(講|說|談|聊)|剛剛?(電話|通話)|剛才(電話|通話)|你們電話(說|講)|通話後|講電話時|電話說的|電話講的|電話談的/;
const RE_QUOTE_MISSING = /上次(你|你們)(說|講)|你們說的|之前(你|你們)(講|說)|剛剛說的|你剛說/;
const H = 3_600_000, D = 24 * H;
export function detectCoverage(msgs: BundleMessage[]): { coverage: "full" | "partial" | "low"; note: string } {
  const cust = msgs.filter((m) => m.role === "customer"), staff = msgs.filter((m) => m.role === "staff");
  if (cust.length >= 3 && staff.length === 0) {
    const span = Date.parse(cust[cust.length - 1]!.at) - Date.parse(cust[0]!.at);
    if (span >= 2 * D) return { coverage: "low", note: "只有客戶訊息，回覆可能在 LINE 官方後台或電話裡" };
  }
  for (const m of cust) {
    if (RE_CALL_PAST.test(m.text)) return { coverage: "partial", note: "客戶提到電話裡談的內容，通話不在紀錄裡" };
    if (RE_QUOTE_MISSING.test(m.text)) {
      const t = Date.parse(m.at);
      const replied = staff.some((s) => { const st = Date.parse(s.at); return st < t && st >= t - 3 * D; });
      if (!replied) return { coverage: "partial", note: "客戶引用了紀錄裡沒有的回覆（可能是 LINE 官方後台打的字）" };
    }
  }
  if (msgs.some((m) => m.via === "call")) return { coverage: "partial", note: "有通話紀錄，內容不在訊息裡" };
  return { coverage: "full", note: "" };
}

export async function importBundle(db: DbLike, b: NormalizedBundle, opts: { reset?: boolean; now: string }): Promise<ImportReport> {
  const rep: ImportReport = { source_system: b.source_system, reset: !!opts.reset, counts: {}, skipped: {}, warnings: [] };
  const bump = (k: string, n = 1) => { rep.counts[k] = (rep.counts[k] ?? 0) + n; };
  const skip = (k: string) => { rep.skipped[k] = (rep.skipped[k] ?? 0) + 1; };

  if (opts.reset) for (const t of DATA_TABLES) await db.run(`DELETE FROM ${t}`);

  /* ── 團隊 ── */
  const teamId = new Map<string, number>();
  for (const name of b.teams) {
    await db.run("INSERT OR IGNORE INTO teams (name) VALUES (?)", name);
    const r = await db.first("SELECT id FROM teams WHERE name = ?", name);
    teamId.set(name, Number(r!["id"])); bump("teams");
  }

  /* ── 員工：以 email 為準，已存在就更新名字/角色/團隊/工作性質；暱稱進 staff_aliases ── */
  const staffId = new Map<string, number>();
  for (const s of b.staff) {
    const ex = await db.first("SELECT id FROM users WHERE email = ?", s.email);
    let id: number;
    const job = s.job ?? "", shared = s.seat_shared ?? 0;
    if (ex) {
      id = Number(ex["id"]);
      await db.run("UPDATE users SET name = ?, role = ?, team_id = ?, job = ?, seat_shared = ? WHERE id = ?", s.name, s.role, teamId.get(s.team) ?? null, job, shared, id);
    } else {
      id = Number(await createUser(db, { email: s.email, name: s.name, password: MOCK_STAFF_PASSWORD, role: s.role }));
      await db.run("UPDATE users SET team_id = ?, job = ?, seat_shared = ? WHERE id = ?", teamId.get(s.team) ?? null, job, shared, id);
      bump("staff_created");
    }
    staffId.set(s.name, id);
    for (const a of s.aliases ?? []) {
      const alias = a.trim(); if (!alias || alias === s.name) continue;
      await db.run("INSERT OR IGNORE INTO staff_aliases (user_id, alias, system) VALUES (?,?,?)", id, alias, "line");
      staffId.set(alias, id); bump("aliases");
    }
  }
  /* reset 時把不在這份 bundle 裡的非管理員帳號一起清掉（連同登入 session）：
     不然換一批資料（模擬→真實）後，舊員工還留在員工效能與車款表上，全是 0。管理員帳號永遠保留。 */
  if (opts.reset) {
    const keep = new Set(b.staff.map((s) => s.email));
    const stale = (await db.all("SELECT id, email FROM users WHERE role <> 'admin'")).filter((u) => !keep.has(String(u["email"])));
    for (const u of stale) { await db.run("DELETE FROM sessions WHERE user_id = ?", u["id"]); await db.run("DELETE FROM users WHERE id = ?", u["id"]); bump("staff_removed"); }
  }
  const sid = (name: string | null | undefined): number | null => (name && staffId.get(name)) || null;

  /* ── 車輛（對齊車源表）── */
  const vehId = new Map<string, number>();
  for (const v of b.vehicles) {
    const costKnown = v.cost != null ? 1 : 0;
    const r = await db.run(
      `INSERT INTO vehicles (brand, model, year, body_type, list_price, cost, cost_known, stock_status, external_id, plate, plate_norm, color, trim, mileage_km, stock_in_at, cert, sell_price, source, peer_dealer, status_text)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      v.brand, v.model, v.year, v.body_type, v.list_price, v.cost ?? 0, costKnown, v.stock_status, v.key,
      v.plate ?? "", normalizePlate(v.plate), v.color ?? "", v.trim ?? "", v.mileage_km ?? null, v.stock_in_at ?? null, v.cert ?? "", v.sell_price ?? null,
      v.source ?? (v.stock_status === "peer" ? "peer" : "stock"), v.peer_dealer ?? "", v.status_text ?? "");
    vehId.set(v.key, r.lastRowId); bump("vehicles");
  }
  const vid = (key: string | null | undefined): number | null => (key && vehId.get(key)) || null;

  /* ── 客戶（＋渠道別名，讓既有收件匣認得）── */
  const custId = new Map<string, number>();
  for (const c of b.customers) {
    const dup = await db.first("SELECT entity_id FROM source_records WHERE source_system = ? AND entity = 'contact' AND external_id = ?", b.source_system, c.key);
    if (dup) { custId.set(c.key, Number(dup["entity_id"])); skip("customers"); continue; }
    const r = await db.run(
      `INSERT INTO contacts (display_name, phone, grade, note, blocked, created_at, pseudonym, external_key, first_contact_at, source_system)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      c.display_name, c.phone, c.grade, "", c.blocked, c.first_contact_at, c.pseudonym, c.external_key, c.first_contact_at, b.source_system);
    custId.set(c.key, r.lastRowId);
    await db.run("INSERT OR IGNORE INTO contact_channels (contact_id, channel, channel_uid, source) VALUES (?,?,?,?)", r.lastRowId, "line", `${b.source_system}:${c.key}`, "");
    await db.run("INSERT OR IGNORE INTO source_records (source_system, entity, entity_id, external_id, captured_at) VALUES (?,?,?,?,?)", b.source_system, "contact", r.lastRowId, c.key, opts.now);
    bump("customers");
  }
  const cid = (key: string): number => { const id = custId.get(key); if (!id) throw new Error(`customer key 找不到：${key}`); return id; };

  /* ── 旅程 ── */
  const leadId = new Map<string, number>();
  for (const l of b.leads) {
    const r = await db.run(
      `INSERT INTO leads (contact_id, staff_id, vehicle_id, source, stage, outcome, opened_at, closed_at) VALUES (?,?,?,?,?,?,?,?)`,
      cid(l.customer_key), sid(l.staff_name), vid(l.vehicle_key), l.source, "new", l.outcome, l.opened_at, l.closed_at);
    leadId.set(l.key, r.lastRowId); bump("leads");
  }
  const lid = (key: string | null | undefined): number | null => (key && leadId.get(key)) || null;

  /* ── 對話與訊息 ── */
  for (const cv of b.conversations) {
    const dup = await db.first("SELECT entity_id FROM source_records WHERE source_system = ? AND entity = 'conversation' AND external_id = ?", b.source_system, cv.key);
    if (dup) { skip("conversations"); continue; }
    if (!cv.messages.length) { rep.warnings.push(`對話 ${cv.key} 沒有訊息，略過`); skip("conversations"); continue; }
    const msgs = [...cv.messages].sort((a, z) => a.at.localeCompare(z.at));
    const first = msgs[0]!, last = msgs[msgs.length - 1]!;
    // 未讀＝結尾連續的客戶訊息
    let unread = 0; for (let i = msgs.length - 1; i >= 0 && msgs[i]!.role === "customer"; i--) unread++;
    const lead = cv.lead_key ? b.leads.find((l) => l.key === cv.lead_key) : undefined;
    const status = lead?.outcome ? "closed" : "open";
    const cov = cv.coverage ? { coverage: cv.coverage, note: cv.coverage_note ?? "" } : detectCoverage(msgs);
    const r = await db.run(
      `INSERT INTO conversations (contact_id, channel, assigned_to, status, last_message_at, unread, created_at, lead_id, external_id, coverage, coverage_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      cid(cv.customer_key), cv.channel, sid(cv.assigned_staff), status, last.at, unread, first.at, lid(cv.lead_key), cv.key, cov.coverage, cov.note);
    const convId = r.lastRowId;
    if (cov.coverage !== "full") bump(`coverage_${cov.coverage}`);
    for (const m of msgs) {
      const dir = m.role === "customer" ? "in" : "out";
      const sc = scrubMessage(m); if (sc.note) bump("id_photos_dropped");
      await db.run(
        `INSERT INTO messages (conversation_id, direction, sender_user_id, text, created_at, sender_role, msg_type, external_id, via)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        convId, dir, m.role === "staff" ? sid(m.staff_name) : null, sc.text, m.at, m.role, sc.type, "", m.via ?? "");
      bump("messages");
    }
    await db.run("INSERT OR IGNORE INTO source_records (source_system, entity, entity_id, external_id, captured_at) VALUES (?,?,?,?,?)", b.source_system, "conversation", convId, cv.key, opts.now);
    bump("conversations");
  }

  /* ── 指派／交接紀錄（可選）── */
  for (const a of b.assignments ?? []) {
    const cv = await db.first("SELECT id FROM conversations WHERE external_id = ? ORDER BY id LIMIT 1", a.conversation_key);
    const by = sid(a.by_staff) ?? sid(a.to_staff);
    if (!cv || !by) { rep.warnings.push(`指派紀錄找不到對話或人：${a.conversation_key}`); continue; }
    await db.run("INSERT INTO assignment_log (conversation_id, from_user_id, to_user_id, by_user_id, created_at) VALUES (?,?,?,?,?)",
      Number(cv["id"]), sid(a.from_staff), sid(a.to_staff), by, a.at);
    await db.run("UPDATE conversations SET assigned_to = ? WHERE id = ?", sid(a.to_staff), Number(cv["id"]));
    bump("assignments");
  }

  /* ── 預約 ── */
  const apptByLead = new Map<number, number[]>();
  for (const a of b.appointments) {
    const l = lid(a.lead_key); if (!l) { rep.warnings.push(`預約找不到 lead ${a.lead_key}`); continue; }
    const r = await db.run(
      `INSERT INTO appointments (lead_id, staff_id, proposed_at, scheduled_for, status, status_at) VALUES (?,?,?,?,?,?)`,
      l, sid(a.staff_name), a.proposed_at, a.scheduled_for, a.status, a.status_at);
    if (a.status === "completed") apptByLead.set(l, [...(apptByLead.get(l) ?? []), r.lastRowId]);
    bump("appointments");
  }

  /* ── 到店（接待群貼文或其他表）── */
  for (const v of b.visits) {
    const l = lid(v.lead_key); if (!l) continue;
    const apptId = v.after_appointment ? (apptByLead.get(l)?.at(-1) ?? null) : null;
    await db.run(`INSERT INTO visits (lead_id, appointment_id, staff_id, visited_at, outcome, note, source, customer_ref, model_text, assigned_by, raw_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      l, apptId, sid(v.staff_name), v.visited_at, v.outcome, v.note, v.source ?? "ledger", v.customer_ref ?? "", v.model_text ?? "", v.assigned_by ?? "", v.raw_text ?? "");
    bump("visits"); if (v.source === "reception") bump("visits_reception");
  }

  /* ── 成交/流失帳本 ── */
  for (const d of b.deals) {
    const costSource = d.cost == null ? "none" : (d.cost_source ?? "ledger");
    const gp = d.cost == null ? 0 : (d.gross_profit ?? d.sale_price - d.cost);
    const r = await db.run(
      `INSERT INTO deals (lead_id, contact_id, staff_id, vehicle_id, status, sale_price, cost, gross_profit, lost_reason, closed_at, external_key, source_system,
                          plate, deposit, loan_status, delivery_by, reported_by, source_kind, peer_dealer, cost_source, gp_is_estimate)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      lid(d.lead_key), cid(d.customer_key), sid(d.staff_name), vid(d.vehicle_key), d.status, d.sale_price, d.cost ?? 0, gp,
      d.lost_reason, d.closed_at, d.external_key, b.source_system,
      d.plate ?? "", d.deposit ?? "", d.loan_status ?? "", d.delivery_by ?? "", d.reported_by ?? "", d.source_kind ?? "stock", d.peer_dealer ?? "", costSource, costSource === "sheet" ? 1 : 0);
    await db.run("INSERT OR IGNORE INTO source_records (source_system, entity, entity_id, external_id, captured_at) VALUES (?,?,?,?,?)",
      b.source_system, "deal", r.lastRowId, `${d.lead_key}:${d.status}`, opts.now);
    bump("deals"); if (costSource === "none") bump("deals_no_cost");
  }

  /* ── 群組貼文原文：最後處理（配對要先有車與客戶；先跑一次漏斗，到店／議價訊號才能幫忙挑客戶）── */
  const dr = b.deal_reports ?? [], ap = b.appraisals ?? [];
  if (dr.length || ap.length) {
    await runFunnel(db, { now: opts.now });
    const r1 = dr.length ? await ingestPosts(db, dr.map((p) => ({ at: p.reported_at, sender: p.reported_by, text: p.raw_text })), { kind: "deal", source_system: b.source_system, now: opts.now }) : null;
    const r2 = ap.length ? await ingestPosts(db, ap.map((p) => ({ at: p.reported_at, sender: p.reported_by, text: p.raw_text })), { kind: "appraisal", source_system: b.source_system, now: opts.now }) : null;
    rep.posts = { deal_reports: r1?.deal_reports ?? 0, auto: r1?.auto ?? 0, suggested: r1?.suggested ?? 0, unmatched: r1?.unmatched ?? 0, appraisals: r2?.appraisals ?? 0, unparsed: (r1?.unparsed.length ?? 0) + (r2?.unparsed.length ?? 0) };
    for (const w of [...(r1?.warnings ?? []), ...(r2?.warnings ?? [])].slice(0, 10)) if (!rep.warnings.includes(w)) rep.warnings.push(w);
  }
  return rep;
}
