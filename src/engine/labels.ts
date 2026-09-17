/**
 * 人工判讀 vs 系統：把人標的答案存進 label_reviews，準確率每次現算（規則改了就跟著變）。
 * 標籤鍵跟 labels.yaml 一致：grade、PRICE_MENTIONED、PRICE_DROP_OFF、APPOINTMENT_PROPOSED、APPOINTMENT_BOOKED、
 * HIGH_INTENT、FINANCING_QUESTION、financing_resolved、SOLD、result_tag。
 */
import type { DbLike } from "../adapters/import.ts";
type Row = Record<string, unknown>;

export const LABEL_KEYS = ["grade", "PRICE_MENTIONED", "PRICE_DROP_OFF", "APPOINTMENT_PROPOSED", "APPOINTMENT_BOOKED", "HIGH_INTENT", "FINANCING_QUESTION", "financing_resolved", "SOLD", "result_tag"] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];
export const LABEL_LABEL: Record<LabelKey, string> = {
  grade: "SABC 分級", PRICE_MENTIONED: "業務報價", PRICE_DROP_OFF: "報價後流失", APPOINTMENT_PROPOSED: "提議看車", APPOINTMENT_BOOKED: "預約成立",
  HIGH_INTENT: "急迫", FINANCING_QUESTION: "問貸款", financing_resolved: "貸款有答", SOLD: "成交", result_tag: "結果標籤",
};
const EVENT_KEYS = new Set(["PRICE_MENTIONED", "PRICE_DROP_OFF", "APPOINTMENT_PROPOSED", "APPOINTMENT_BOOKED", "HIGH_INTENT", "FINANCING_QUESTION", "SOLD"]);

export interface LabelRowIn { pseudonym?: string; lead_id?: number; external_id?: string; labeled_at?: string; note?: string; labels: Record<string, string> }

/** 正規化人標的值：true/false/unsure，分級大寫，其餘照字串；空／不適用 → 略過（回 null）。 */
export function normalizeValue(key: string, raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v || v === "不適用" || v === "na" || v === "n/a") return null;
  if (key === "grade") return /^[SABC]$/i.test(v) ? v.toUpperCase() : null;
  if (key === "result_tag") return v.slice(0, 60);
  const low = v.toLowerCase();
  if (["true", "1", "yes", "y", "對", "有", "是"].includes(low)) return "true";
  if (["false", "0", "no", "n", "錯", "沒有", "否", "無"].includes(low)) return "false";
  if (["unsure", "不確定", "?", "不知道"].includes(low)) return "unsure";
  return null;
}

/** 匯入一批人工判讀。lead 由 lead_id 或 pseudonym 找；找不到的回在 unmatched。 */
export async function importLabels(db: DbLike, opts: { source: string; batch: string; reviewer: string; rows: LabelRowIn[]; now: string }) {
  let imported = 0, leads = 0; const unmatched: string[] = [];
  for (const r of opts.rows) {
    let leadId = r.lead_id ? Number(r.lead_id) : 0;
    if (!leadId && r.pseudonym) {
      const row = await db.first("SELECT l.id FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.pseudonym = ? ORDER BY l.opened_at DESC LIMIT 1", r.pseudonym);
      leadId = row ? Number(row["id"]) : 0;
    }
    if (!leadId) { unmatched.push(r.external_id || r.pseudonym || "?"); continue; }
    let any = false;
    for (const [key, raw] of Object.entries(r.labels || {})) {
      if (!(LABEL_KEYS as readonly string[]).includes(key)) continue;
      const v = normalizeValue(key, raw); if (v == null) continue;
      await db.run(`INSERT INTO label_reviews (lead_id, source, batch, external_id, target_key, human_value, note, reviewer, labeled_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(lead_id, source, target_key) DO UPDATE SET human_value = excluded.human_value, note = excluded.note, reviewer = excluded.reviewer, labeled_at = excluded.labeled_at, batch = excluded.batch, external_id = excluded.external_id`,
        leadId, opts.source, opts.batch, r.external_id ?? "", key, v, (r.note ?? "").slice(0, 500), opts.reviewer, r.labeled_at ?? "", opts.now);
      imported++; any = true;
    }
    if (any) leads++;
  }
  return { imported, leads, unmatched };
}

/** 系統對這個 lead 每個標籤的答案（跟人標同一種值域）。 */
export async function systemValues(db: DbLike, leadId: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const lead = await db.first("SELECT grade_auto, result_tag FROM leads WHERE id = ?", leadId);
  if (lead) { out["grade"] = String(lead["grade_auto"] || ""); out["result_tag"] = String(lead["result_tag"] || ""); }
  const evs = await db.all("SELECT type, detail FROM funnel_events WHERE lead_id = ? AND confidence <> 'UNCLEAR'", leadId);
  const have = new Set(evs.map((e) => String(e["type"])));
  for (const k of EVENT_KEYS) out[k] = have.has(k) ? "true" : "false";
  const fin = evs.find((e) => e["type"] === "FINANCING_QUESTION");
  if (fin) { let resolved: unknown = null; try { resolved = JSON.parse(String(fin["detail"] || "{}"))?.resolved; } catch { /* ignore */ } out["financing_resolved"] = resolved === true ? "true" : resolved === false ? "false" : ""; }
  return out;
}

export interface LabelSummaryRow { key: string; label: string; n: number; agree: number; disagree: number; unsure: number; system_yes_human_no: number; human_yes_system_no: number; precision: number | null; recall: number | null; accuracy: number | null }

/** 每個標籤：看了幾筆、對幾筆、錯幾筆，以及事件類的 precision／recall。 */
export async function labelSummary(db: DbLike, source?: string): Promise<{ rows: LabelSummaryRow[]; disagreements: Row[]; leads: number; sources: string[] }> {
  const where = source ? "WHERE r.source = ?" : "";
  const rows = await db.all(`SELECT r.lead_id, r.source, r.target_key, r.human_value, r.note, r.external_id, c.pseudonym FROM label_reviews r JOIN leads l ON l.id = r.lead_id JOIN contacts c ON c.id = l.contact_id ${where} ORDER BY r.lead_id, r.target_key`, ...(source ? [source] : []));
  const byLead = new Map<number, Row[]>();
  for (const r of rows) { const id = Number(r["lead_id"]); byLead.set(id, [...(byLead.get(id) ?? []), r]); }
  const acc = new Map<string, LabelSummaryRow>();
  const get = (k: string) => { if (!acc.has(k)) acc.set(k, { key: k, label: LABEL_LABEL[k as LabelKey] ?? k, n: 0, agree: 0, disagree: 0, unsure: 0, system_yes_human_no: 0, human_yes_system_no: 0, precision: null, recall: null, accuracy: null }); return acc.get(k)!; };
  const disagreements: Row[] = [];
  for (const [leadId, list] of byLead) {
    const sys = await systemValues(db, leadId);
    for (const r of list) {
      const k = String(r["target_key"]); const hv = String(r["human_value"]); const sv = sys[k] ?? "";
      const s = get(k); s.n++;
      if (hv === "unsure") { s.unsure++; continue; }
      if (k === "financing_resolved" && !sv) { s.unsure++; continue; }   // 系統沒抓到貸款問題就沒有「有答」可比
      if (hv === sv) s.agree++;
      else {
        s.disagree++;
        if (sv === "true" && hv === "false") s.system_yes_human_no++;
        if (sv === "false" && hv === "true") s.human_yes_system_no++;
        disagreements.push({ lead_id: leadId, pseudonym: r["pseudonym"], source: r["source"], key: k, label: LABEL_LABEL[k as LabelKey] ?? k, human: hv, system: sv, note: r["note"], external_id: r["external_id"] });
      }
    }
  }
  for (const s of acc.values()) {
    const decided = s.agree + s.disagree;
    s.accuracy = decided ? s.agree / decided : null;
    if (EVENT_KEYS.has(s.key)) {
      // precision＝系統說有的裡面人也說有；recall＝人說有的裡面系統也抓到
      const tp = s.agree - 0; // 需要 true/true 的數，下面重算
      void tp;
    }
  }
  // 事件類的 precision／recall 要 true/true 數，再掃一次
  const tt = new Map<string, number>();
  for (const [leadId, list] of byLead) {
    const sys = await systemValues(db, leadId);
    for (const r of list) { const k = String(r["target_key"]); if (EVENT_KEYS.has(k) && r["human_value"] === "true" && sys[k] === "true") tt.set(k, (tt.get(k) ?? 0) + 1); }
  }
  for (const s of acc.values()) {
    if (!EVENT_KEYS.has(s.key)) continue;
    const t = tt.get(s.key) ?? 0; const sysYes = t + s.system_yes_human_no; const humYes = t + s.human_yes_system_no;
    s.precision = sysYes ? t / sysYes : null; s.recall = humYes ? t / humYes : null;
  }
  const order = LABEL_KEYS as readonly string[];
  const sources = [...new Set(rows.map((r) => String(r["source"])))];
  return { rows: [...acc.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)), disagreements, leads: byLead.size, sources };
}
