/**
 * 歸因引擎 —— 一位員工在一個 lead 上扮演什麼角色（規則全部決定性、每個角色指到一則訊息或一筆帳本）。
 *
 *   primary       結案時的負責業務（成交／流失帳本優先，否則 lead 指派）
 *   supporting    非主要業務、在結案前於同一對話發過至少一則實質訊息（交接宣告、圖片、貼圖不算）
 *   manager       admin／operator 在結案前發過訊息
 *   handoff_from / handoff_to
 *                 assignment_log 有紀錄；沒有帳本時，對話中發言業務由 A 換成 B、A 之後不再發言、B 的第一則像交接用語
 *   reactivation  RE_ENGAGED 前 7 天內有這位員工的 FOLLOW_UP；客戶自己回來的不記功
 *
 * 「影響」的算法（直接 vs 影響）在 staff.ts；這裡只負責把角色算對、寫進 lead_roles。
 * 規則說明見 docs/STAFF_EFFECTIVENESS.md §1。
 */
import type { DbLike } from "../adapters/import.ts";
import type { LeadRole } from "../model/types.ts";

type Row = Record<string, unknown>;
const H = 3_600_000, D = 24 * H;
const num = (v: unknown) => Number(v ?? 0) || 0;
/** 交接宣告用語：出現在換人後第一則 */
export const RE_HANDOFF = /接手|休假|之後由我|由我為您服務|先幫您處理/;

export interface RoleHit { user_id: number; role: LeadRole; confidence: "CONFIRMED" | "STRONGLY_SUGGESTED"; at: string; message_id: number | null; note: string }

export async function rolesForLead(db: DbLike, lead: Row, users: Map<number, { name: string; role: string }>): Promise<RoleHit[]> {
  const lid = num(lead["id"]);
  const hits: RoleHit[] = [];
  const deal = await db.first("SELECT staff_id, closed_at FROM deals WHERE lead_id = ? ORDER BY id LIMIT 1", lid);
  const closedAt = lead["closed_at"] ? Date.parse(String(lead["closed_at"])) : Infinity;
  const primary = num(deal?.["staff_id"]) || num(lead["staff_id"]);
  if (primary) hits.push({ user_id: primary, role: "primary", confidence: "CONFIRMED", at: String(lead["opened_at"]), message_id: null, note: deal ? "成交／流失帳本上的業務" : "lead 指派的業務" });

  const msgs = await db.all(
    `SELECT m.id, m.sender_user_id, m.text, m.created_at, m.msg_type FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.lead_id = ? AND m.sender_role = 'staff' AND m.sender_user_id IS NOT NULL ORDER BY m.created_at, m.id`, lid);

  /* ── 交接：帳本優先 ── */
  const cvIds = (await db.all("SELECT id FROM conversations WHERE lead_id = ?", lid)).map((r) => num(r["id"]));
  const logs = cvIds.length ? await db.all(`SELECT * FROM assignment_log WHERE conversation_id IN (${cvIds.map(() => "?").join(",")}) ORDER BY created_at`, ...cvIds) : [];
  const pairs: Array<{ from: number; to: number; at: string; msg: number | null; conf: RoleHit["confidence"]; note: string }> = [];
  for (const g of logs) {
    const f = num(g["from_user_id"]), t = num(g["to_user_id"]);
    if (f && t && f !== t) pairs.push({ from: f, to: t, at: String(g["created_at"]), msg: null, conf: "CONFIRMED", note: "指派紀錄" });
  }
  if (!pairs.length) {
    for (let i = 1; i < msgs.length; i++) {
      const a = num(msgs[i - 1]!["sender_user_id"]), b = num(msgs[i]!["sender_user_id"]);
      if (a === b) continue;
      const aLater = msgs.slice(i + 1).some((m) => num(m["sender_user_id"]) === a);
      if (!aLater && users.get(b)?.role === "agent" && RE_HANDOFF.test(String(msgs[i]!["text"]))) {
        pairs.push({ from: a, to: b, at: String(msgs[i]!["created_at"]), msg: num(msgs[i]!["id"]), conf: "STRONGLY_SUGGESTED", note: "對話中換人發言、前手之後沒再出現、接手者第一則有交接用語" });
        break;
      }
    }
  }
  for (const p of pairs) {
    hits.push({ user_id: p.from, role: "handoff_from", confidence: p.conf, at: p.at, message_id: p.msg, note: p.note });
    hits.push({ user_id: p.to, role: "handoff_to", confidence: p.conf, at: p.at, message_id: p.msg, note: p.note });
  }

  /* ── 支援／主管介入：非主要業務、結案前、實質訊息 ── */
  const seen = new Set<number>();
  for (const m of msgs) {
    const uid = num(m["sender_user_id"]);
    if (!uid || uid === primary || seen.has(uid)) continue;
    if (Date.parse(String(m["created_at"])) > closedAt) continue;
    if (String(m["msg_type"] ?? "text") !== "text" || RE_HANDOFF.test(String(m["text"]))) continue;
    if (pairs.some((p) => p.from === uid || p.to === uid)) continue;     // 交接雙方另外算
    const u = users.get(uid); if (!u) continue;
    seen.add(uid);
    const isMgr = u.role === "admin" || u.role === "operator";
    hits.push({ user_id: uid, role: isMgr ? "manager" : "supporting", confidence: "CONFIRMED", at: String(m["created_at"]), message_id: num(m["id"]), note: isMgr ? "主管在結案前介入對話" : "非主要業務在結案前發過實質訊息" });
  }

  /* ── 回流貢獻：RE_ENGAGED 前 7 天內有這位員工的跟進 ── */
  const reeng = await db.all("SELECT at FROM funnel_events WHERE lead_id = ? AND type = 'RE_ENGAGED' ORDER BY at", lid);
  for (const r of reeng) {
    const rAt = Date.parse(String(r["at"]));
    const fu = await db.first(
      `SELECT x.message_id, m.sender_user_id FROM funnel_events e JOIN evidence x ON x.event_id = e.id JOIN messages m ON m.id = x.message_id
        WHERE e.lead_id = ? AND e.type = 'FOLLOW_UP' AND e.at < ? AND e.at >= ? ORDER BY e.at DESC LIMIT 1`, lid, r["at"], new Date(rAt - 7 * D).toISOString());
    const uid = num(fu?.["sender_user_id"]);
    if (!uid) continue;
    const progressed = await db.first(`SELECT 1 FROM funnel_events WHERE lead_id = ? AND at >= ? AND type IN ('APPOINTMENT_PROPOSED','APPOINTMENT_BOOKED','STORE_VISIT','NEGOTIATION','SOLD') LIMIT 1`, lid, r["at"]);
    const back = await db.first(`SELECT m.text FROM funnel_events e JOIN evidence x ON x.event_id = e.id JOIN messages m ON m.id = x.message_id WHERE e.lead_id = ? AND e.type = 'RE_ENGAGED' AND e.at = ? LIMIT 1`, lid, r["at"]);
    const negative = /跟朋友買|買了別家|別家買|先不換|預算不夠|不用了|之後再說|不買了|算了/.test(String(back?.["text"] ?? ""));
    if (!progressed || negative) continue;                                   // 回來只是為了說不買，不算救回
    if (!hits.some((h) => h.user_id === uid && h.role === "reactivation")) {
      hits.push({ user_id: uid, role: "reactivation", confidence: "CONFIRMED", at: String(r["at"]), message_id: num(fu!["message_id"]) || null, note: "客戶回流前 7 天內有這位員工的主動跟進" });
    }
  }
  return hits;
}

/** 跑全部（或指定）lead，重寫 lead_roles */
export async function computeRoles(db: DbLike, opts: { leadIds?: number[] }): Promise<{ leads: number; roles: number; by_role: Record<string, number> }> {
  const users = new Map<number, { name: string; role: string }>((await db.all("SELECT id, name, role FROM users")).map((u) => [num(u["id"]), { name: String(u["name"]), role: String(u["role"]) }]));
  const leads = opts.leadIds?.length
    ? await db.all(`SELECT * FROM leads WHERE id IN (${opts.leadIds.map(() => "?").join(",")})`, ...opts.leadIds)
    : await db.all("SELECT * FROM leads");
  let total = 0; const by: Record<string, number> = {};
  for (const l of leads) {
    const lid = num(l["id"]);
    const hits = await rolesForLead(db, l, users);
    await db.run("DELETE FROM lead_roles WHERE lead_id = ?", lid);
    for (const h of hits) {
      await db.run("INSERT OR IGNORE INTO lead_roles (lead_id, user_id, role, confidence, at, evidence_message_id, note) VALUES (?,?,?,?,?,?,?)",
        lid, h.user_id, h.role, h.confidence, h.at, h.message_id, h.note);
      total++; by[h.role] = (by[h.role] ?? 0) + 1;
    }
  }
  return { leads: leads.length, roles: total, by_role: by };
}
