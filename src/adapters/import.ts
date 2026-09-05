/**
 * 匯入 NormalizedBundle → 資料庫。
 *
 * 這是所有來源的共同入口：模擬器、Super 8 瀏覽器擷取、瑋瑋的表、之後的 API，
 * 全部先變成 bundle 再走這裡。系統其他部分不知道也不該知道資料從哪來。
 *
 * 用字串 key 互相參照，這裡換成 id。同一個 bundle 重匯不會重複：
 * source_records 以 (source_system, entity, external_id) 唯一。
 */
import type { NormalizedBundle } from "../model/bundle.ts";
import { createUser } from "../auth.js";

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
}

/** 清掉資料表，但保留帳號、工作階段、設定、自動回覆規則 */
const DATA_TABLES = [
  "evidence", "actions", "insights", "briefs", "lead_roles", "loss_analyses", "behaviors", "coaching_plans", "funnel_events", "visits", "appointments",
  "deals", "leads", "autoreply_log", "messages", "assignment_log", "conversations",
  "contact_channels", "contacts", "vehicles", "source_records", "teams",
];

const MOCK_STAFF_PASSWORD = "test-pass-123";   // 模擬員工的密碼；真員工帳號另外建

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

  /* ── 員工：以 email 為準，已存在就更新名字/角色/團隊 ── */
  const staffId = new Map<string, number>();
  for (const s of b.staff) {
    const ex = await db.first("SELECT id FROM users WHERE email = ?", s.email);
    let id: number;
    if (ex) {
      id = Number(ex["id"]);
      await db.run("UPDATE users SET name = ?, role = ?, team_id = ? WHERE id = ?", s.name, s.role, teamId.get(s.team) ?? null, id);
    } else {
      id = Number(await createUser(db, { email: s.email, name: s.name, password: MOCK_STAFF_PASSWORD, role: s.role }));
      await db.run("UPDATE users SET team_id = ? WHERE id = ?", teamId.get(s.team) ?? null, id);
      bump("staff_created");
    }
    staffId.set(s.name, id);
  }
  const sid = (name: string | null | undefined): number | null => (name && staffId.get(name)) || null;

  /* ── 車輛 ── */
  const vehId = new Map<string, number>();
  for (const v of b.vehicles) {
    const r = await db.run(
      `INSERT INTO vehicles (brand, model, year, body_type, list_price, cost, stock_status, external_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      v.brand, v.model, v.year, v.body_type, v.list_price, v.cost, v.stock_status, v.key);
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
    const r = await db.run(
      `INSERT INTO conversations (contact_id, channel, assigned_to, status, last_message_at, unread, created_at, lead_id, external_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      cid(cv.customer_key), cv.channel, sid(cv.assigned_staff), status, last.at, unread, first.at, lid(cv.lead_key), cv.key);
    const convId = r.lastRowId;
    for (const m of msgs) {
      const dir = m.role === "customer" ? "in" : "out";
      await db.run(
        `INSERT INTO messages (conversation_id, direction, sender_user_id, text, created_at, sender_role, msg_type, external_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        convId, dir, m.role === "staff" ? sid(m.staff_name) : null, m.text, m.at, m.role, m.type ?? "text", "");
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

  /* ── 到店 ── */
  for (const v of b.visits) {
    const l = lid(v.lead_key); if (!l) continue;
    const apptId = v.after_appointment ? (apptByLead.get(l)?.at(-1) ?? null) : null;
    await db.run(`INSERT INTO visits (lead_id, appointment_id, staff_id, visited_at, outcome, note) VALUES (?,?,?,?,?,?)`,
      l, apptId, sid(v.staff_name), v.visited_at, v.outcome, v.note);
    bump("visits");
  }

  /* ── 成交/流失帳本 ── */
  for (const d of b.deals) {
    const r = await db.run(
      `INSERT INTO deals (lead_id, contact_id, staff_id, vehicle_id, status, sale_price, cost, gross_profit, lost_reason, closed_at, external_key, source_system)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      lid(d.lead_key), cid(d.customer_key), sid(d.staff_name), vid(d.vehicle_key), d.status, d.sale_price, d.cost, d.gross_profit,
      d.lost_reason, d.closed_at, d.external_key, b.source_system);
    await db.run("INSERT OR IGNORE INTO source_records (source_system, entity, entity_id, external_id, captured_at) VALUES (?,?,?,?,?)",
      b.source_system, "deal", r.lastRowId, `${d.lead_key}:${d.status}`, opts.now);
    bump("deals");
  }
  return rep;
}
