/**
 * 員工效能引擎 —— 指標、門檻、排名、表現最佳／需要關注、成功 vs 需關注的行為對照、成功模式庫、同儕分層。
 *
 * 原則：
 *   - 全部決定性；每個比例都帶樣本數；沒達門檻就 ok=false（畫面顯示「資料不足」、排名不排）
 *   - 排序用 Wilson 95% 下界：2/4 的 50% 排不到 21/50 的 42% 前面
 *   - 「影響」＝以任一角色出現在成交案，每案算一次、金額不拆分；只標「關聯」
 *   - 對照只講「觀察到的關聯」，不寫成因果；文字都是「表現最佳組在 X 的比例是 A%，需關注組 B%」
 * 規則說明見 docs/STAFF_EFFECTIVENESS.md。
 */
import type { DbLike } from "../adapters/import.ts";
import { FEATURE_LABEL } from "./behavior.ts";
import { LOSS_LABEL, STAGE_LABEL, PROCESS_REASONS } from "./loss.ts";

type Row = Record<string, unknown>;
const D = 86_400_000;
const num = (v: unknown) => Number(v ?? 0) || 0;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const rate = (k: number, n: number) => (n > 0 ? r3(k / n) : null);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return r3(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2); };
const mean = (xs: number[]) => (xs.length ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** 最低樣本：低於這個數就「資料不足」 */
export const MIN_N = { close: 10, price_continue: 10, appt: 10, appt_visit: 8, visit_sale: 5, gp_per_deal: 3, response: 10, followup: 5, behavior: 5, reactivation: 3, pair: 2, pair_rate: 5 };   // 組合：2 件就列、5 件才給比例
/** Wilson 95% 下界 */
export function wilsonLow(k: number, n: number, z = 1.96): number {
  if (!n) return 0; const p = k / n; const d = 1 + (z * z) / n; const c = p + (z * z) / (2 * n); const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - s) / d);
}
/** na＝這個指標對這個人不適用（訊息組沒有到店→成交；純業務沒有回覆速度）；shared＝Super 8 座位共用，個人數字不可信，只算到團隊 */
export interface Metric { rate: number | null; k: number; n: number; ok: boolean; low: number; na?: boolean; shared?: boolean }
const M = (k: number, n: number, min: number): Metric => ({ rate: rate(k, n), k, n, ok: n >= min, low: n ? r3(wilsonLow(k, n)) : 0 });
export interface NumMetric { value: number | null; n: number; ok: boolean; na?: boolean; shared?: boolean }
const NM = (xs: number[], min: number, agg: "median" | "mean" = "median"): NumMetric => ({ value: agg === "median" ? median(xs) : mean(xs), n: xs.length, ok: xs.length >= min });
const NA = <T extends Metric | NumMetric>(m: T): T => ({ ...m, ok: false, na: true });
const SHARED = <T extends Metric | NumMetric>(m: T): T => ({ ...m, ok: false, shared: true });
/** 毛利只認成本知道的成交 */
const gpOf = (d: Row) => (String(d["cost_source"] ?? "ledger") === "none" ? 0 : num(d["gross_profit"]));

export const RATE_FEATURES = ["followup_24h_rate", "asked_after_price", "objection_clarified", "proposed_after_intent", "fin_answered", "postvisit_24h", "budget_clarified", "opening_question", "reactivated_by_staff", "escalated"] as const;
export const NUM_FEATURES: Record<string, "median" | "mean"> = { first_response_min: "median", median_response_min: "median", questions_per_msg: "mean", discount_pct: "mean", staff_msgs: "mean" };
export const BAND = (price: number | null): string => (price == null ? "未知" : price < 800_000 ? "入門（<80 萬）" : price < 1_300_000 ? "中階（80–130 萬）" : "高階（130 萬+）");

export interface StaffMetrics {
  id: number; name: string; team: string;
  /** chat＝訊息組（線上回訊息）、sales＝業務（到店、成交）、both＝兩者；訊息面指標算訊息組、成交面指標算業務 */
  job: string; seat_shared: boolean;
  context: { leads: number; chat_leads: number; chat_note: string; open: number; closed: number; median_list_price: number | null; band: string; bands: Record<string, number>; first_seen: string | null; peer_note: string };
  activity: { first_response: NumMetric; response: NumMetric; followup_24h: Metric; stale: number; handoffs_out: number; handoffs_in: number; reactivations: number; reactivation_rate: Metric; supported: number; manager_interventions: number; cross_team_support: number; active_conversations: number };
  funnel: { priced: number; booked: number; visited: number; price_continue: Metric; appt: Metric; appt_visit: Metric; visit_sale: Metric; close: Metric; dropoff: Metric };
  /** gp 只算成本知道的成交；gp_unknown＝沒有成本（同行車／車號空白）的成交筆數；gp_estimate＝其中車源表成本估算的筆數 */
  commercial: { sold: number; lost: number; revenue: number; gp: number; gp_known: number; gp_unknown: number; gp_estimate: number; avg_price: number | null; avg_gp: NumMetric; avg_days: number | null; influenced_sold: number; influenced_gp: number; influenced_revenue: number; discount: NumMetric; below_cost: number; margin: number | null };
  behaviors: Record<string, Metric | NumMetric>;
  loss: { n: number; reasons: Array<{ key: string; label: string; k: number; rate: number | null }>; stages: Array<{ stage: string; label: string; k: number }>; driver: { customer: number; process: number; unclear: number } };
  prev: { sold: number; gp: number; close: Metric; leads: number };
}
export interface RankRow { staff_id: number; name: string; team: string; value: number | null; display: string; k: number; n: number; ok: boolean; rank: number | null }
export interface Observation { feature: string; label: string; unit: string; top: number | null; watch: number | null; team: number | null; n_top: number; n_watch: number; delta: number | null; text: string; claim: "correlation" }
export interface Issue { key: string; text: string; mine: number | null; team: number | null; n: number; severity: number; pattern: string; coaching: string; affected: number }
export interface Pattern { key: string; label: string; what: string; staff: Array<{ id: number; name: string; value: number | null; n: number }>; n_total: number; outcome: { with: Metric; without: Metric; lift: number | null } | null; evidence: Array<{ lead_id: number; message_id: number | null; contact: string; staff: string }>; confidence: string; claim: "correlation" }
export interface StaffReport {
  period: { from: string; to: string; days: number }; prev: { from: string; to: string };
  staff: StaffMetrics[]; team: { funnel: StaffMetrics["funnel"]; commercial: Pick<StaffMetrics["commercial"], "sold" | "lost" | "revenue" | "gp" | "gp_known" | "gp_unknown" | "gp_estimate" | "avg_gp" | "margin" | "below_cost">; activity: Pick<StaffMetrics["activity"], "first_response" | "response" | "followup_24h">; behaviors: Record<string, Metric | NumMetric>; leads: number; loss: StaffMetrics["loss"]; prev: { sold: number; gp: number; leads: number; close: Metric } };
  teams: Array<{ name: string; staff: number; leads: number; sold: number; revenue: number; gp: number; close: Metric; handoff_success: Metric; cross_support: number }>;
  rankings: Array<{ key: string; label: string; desc: string; rows: RankRow[] }>;
  top: Array<{ rank: number; staff_id: number; name: string; team: string; reason: string; strength: string; sold: number; close: Metric; revenue: number; gp: number; avg_gp: number | null; appts: number; visits: number; influenced: number; trend: { sold: number; close: number | null } }>;
  watch: Array<{ staff_id: number; name: string; team: string; rank_closers: number | null; leads: number; sold: number; close: Metric; gp: number; lost_stage: string; response: string; followup: string; issue: { key: string; text: string; mine: number | null; team: number | null; n: number }; pattern: string; coaching: string; evidence: { affected_leads: number; lead_ids: number[]; process_losses: number } }>;
  compare: { top_ids: number[]; watch_ids: number[]; observations: Observation[]; summary: string; funnel: Array<{ key: string; label: string; top: Metric; watch: Metric; team: Metric }> };
  associations: Array<{ feature: string; label: string; with: Metric; without: Metric; lift: number | null }>;
  patterns: Pattern[];
  matrix: { reasons: Array<{ key: string; label: string; team_k: number; team_rate: number | null }>; rows: Array<{ staff_id: number; name: string; n: number; cells: Record<string, { k: number; rate: number | null; flag: boolean }> }>; team_n: number };
  pairs: Array<{ a: string; b: string; a_id: number; b_id: number; cases: number; sold: number; rate: number | null; label: "association" }>;
  issues: Record<number, Issue[]>;
  n_agents: number;
  timings?: Record<string, number>;
}

/* ── 主計算 ── */
export async function computeStaffReport(db: DbLike, opts: { days?: number; to?: string }): Promise<StaffReport> {
  const days = opts.days ?? 30;
  const toT = opts.to ? Date.parse(opts.to) : Date.now(), fromT = toT - days * D, pFromT = fromT - days * D;
  const inP = (iso: unknown) => { const t = Date.parse(String(iso ?? "")); return t >= fromT && t < toT; };
  const inPrev = (iso: unknown) => { const t = Date.parse(String(iso ?? "")); return t >= pFromT && t < fromT; };

  const timings: Record<string, number> = {}; let tMark = Date.now();
  const lap = (k: string) => { const t = Date.now(); timings[k] = t - tMark; tMark = t; };
  const users = await db.all("SELECT u.id, u.name, u.role, COALESCE(u.job,'') AS job, COALESCE(u.seat_shared,0) AS seat_shared, COALESCE(t.name,'') AS team FROM users u LEFT JOIN teams t ON t.id = u.team_id");
  const jobOf = (u: Row) => String(u["job"] || "") || (u["role"] === "agent" ? "both" : "manager");
  const agents = users.filter((u) => u["role"] === "agent" || ["chat", "sales", "both"].includes(jobOf(u)));
  const userById = new Map(users.map((u) => [num(u["id"]), u]));
  const leads = await db.all(`SELECT l.id, l.staff_id, l.outcome, l.opened_at, l.closed_at, l.first_real_at, l.vehicle_id, v.list_price, COALESCE(v.brand||' '||v.model,'') AS vehicle, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact
                               FROM leads l LEFT JOIN vehicles v ON v.id = l.vehicle_id JOIN contacts c ON c.id = l.contact_id`);
  const events = await db.all(`SELECT lead_id, type, at FROM funnel_events WHERE confidence <> 'UNCLEAR' AND type IN ('PRICE_MENTIONED','APPOINTMENT_BOOKED','STORE_VISIT','NEGOTIATION','SOLD','HIGH_INTENT','CUSTOMER_INACTIVE','RE_ENGAGED')`);
  // 車源表第一次匯入就是售出／收訂的成交日不明 → 不進員工的本期成交（不然全部落在匯入那一天）
  const deals = await db.all("SELECT lead_id, staff_id, status, sale_price, cost, gross_profit, closed_at, COALESCE(cost_source,'ledger') AS cost_source, COALESCE(gp_is_estimate,0) AS gp_is_estimate, COALESCE(source_kind,'stock') AS source_kind FROM deals WHERE COALESCE(closed_at_source,'') <> 'import'");
  const behaviors = await db.all("SELECT lead_id, staff_id, chat_staff_id, features FROM behaviors");
  /** 這位客戶在線上是誰回的（訊息組 vs 業務拆帳） */
  const chatBy = new Map(behaviors.map((b) => [num(b["lead_id"]), num(b["chat_staff_id"]) || null]));
  const roles = await db.all("SELECT lead_id, user_id, role FROM lead_roles");
  const loss = await db.all("SELECT lead_id, primary_reason, secondary_reason, driver, stage, status FROM loss_analyses");
  // 最後一則員工／任一訊息：用 conversations 上匯入時算好的欄位（以前 GROUP BY 540 萬則訊息，兩句就要好幾秒）
  const lastStaff = await db.all("SELECT lead_id, MAX(last_staff_at) AS at FROM conversations WHERE lead_id IS NOT NULL AND last_staff_at <> '' GROUP BY lead_id");   // 沒回過的 lead 不出現在這裡 → 跟以前一樣算「停滯」
  const lastAny = await db.all("SELECT lead_id, MAX(last_message_at) AS at FROM conversations WHERE lead_id IS NOT NULL GROUP BY lead_id");
  const firstSeen = await db.all("SELECT sender_user_id AS uid, MIN(created_at) AS at FROM messages WHERE sender_role = 'staff' AND sender_user_id IS NOT NULL GROUP BY sender_user_id");

  lap("load");
  const leadById = new Map<number, Row>(leads.map((l) => [num(l["id"]), l]));   // 5 萬個 lead 時 leads.find 是 O(n)，角色列有幾萬筆 → 之前一頁要 70 秒
  const group = <T,>(rows: Row[], key: string, f: (r: Row) => T) => { const m = new Map<number, T[]>(); for (const r of rows) { const k = num(r[key]); if (!m.has(k)) m.set(k, []); m.get(k)!.push(f(r)); } return m; };
  const evBy = group(events, "lead_id", (r) => ({ type: String(r["type"]), at: Date.parse(String(r["at"])) }));
  const dealBy = new Map(deals.map((d) => [num(d["lead_id"]), d]));
  const featBy = new Map(behaviors.map((b) => { let f: Record<string, { v: number | null; msg?: number | null; n?: number }> = {}; try { f = JSON.parse(String(b["features"] || "{}")); } catch { /* ignore */ } return [num(b["lead_id"]), f]; }));
  const rolesBy = group(roles, "lead_id", (r) => ({ uid: num(r["user_id"]), role: String(r["role"]) }));
  const lossBy = new Map(loss.map((l) => [num(l["lead_id"]), l]));
  const lastStaffAt = new Map(lastStaff.map((r) => [num(r["lead_id"]), Date.parse(String(r["at"]))]));
  const lastAnyAt = new Map(lastAny.map((r) => [num(r["lead_id"]), Date.parse(String(r["at"]))]));
  const firstSeenBy = new Map(firstSeen.map((r) => [num(r["uid"]), String(r["at"])]));
  const teamOf = (uid: number) => String(userById.get(uid)?.["team"] ?? "");
  const has = (lid: number, t: string, after = -Infinity) => (evBy.get(lid) ?? []).some((e) => e.type === t && e.at >= after);
  const firstAt = (lid: number, t: string) => (evBy.get(lid) ?? []).find((e) => e.type === t)?.at ?? null;

  /* ── 一組 lead 的統計（員工或全團隊共用）── */
  const funnelOf = (set: Row[]): StaffMetrics["funnel"] => {
    const ids = set.map((l) => num(l["id"]));
    const priced = ids.filter((id) => has(id, "PRICE_MENTIONED"));
    const continued = priced.filter((id) => { const p = firstAt(id, "PRICE_MENTIONED")!; return has(id, "APPOINTMENT_BOOKED", p) || has(id, "NEGOTIATION", p) || has(id, "SOLD", p); });
    const booked = ids.filter((id) => has(id, "APPOINTMENT_BOOKED"));
    const visited = ids.filter((id) => has(id, "STORE_VISIT"));
    const bookedVisited = booked.filter((id) => has(id, "STORE_VISIT", firstAt(id, "APPOINTMENT_BOOKED")!));
    const soldSet = new Set(set.filter((l) => l["outcome"] === "sold").map((l) => num(l["id"])));
    const closed = set.filter((l) => l["outcome"] === "sold" || l["outcome"] === "lost");
    return {
      priced: priced.length, booked: booked.length, visited: visited.length,
      price_continue: M(continued.length, priced.length, MIN_N.price_continue), appt: M(booked.length, ids.length, MIN_N.appt),
      appt_visit: M(bookedVisited.length, booked.length, MIN_N.appt_visit), visit_sale: M(visited.filter((id) => soldSet.has(id)).length, visited.length, MIN_N.visit_sale),
      close: M(soldSet.size, closed.length, MIN_N.close), dropoff: M(closed.length - soldSet.size, closed.length, MIN_N.close),
    };
  };
  const behaviorsOf = (set: Row[]): Record<string, Metric | NumMetric> => {
    const out: Record<string, Metric | NumMetric> = {};
    const feats = set.map((l) => featBy.get(num(l["id"]))).filter((f): f is NonNullable<typeof f> => !!f);
    for (const k of RATE_FEATURES) {
      if (k === "followup_24h_rate") { let kk = 0, nn = 0; for (const f of feats) { const x = f[k]; if (x && x.v != null && x.n) { kk += Math.round(x.v * x.n); nn += x.n; } } out[k] = M(kk, nn, MIN_N.followup); continue; }
      const vals = feats.map((f) => f[k]?.v).filter((v): v is number => v != null);
      out[k] = M(vals.filter((v) => v >= 1).length, vals.length, MIN_N.behavior);
    }
    for (const [k, agg] of Object.entries(NUM_FEATURES)) { const vals = feats.map((f) => f[k]?.v).filter((v): v is number => v != null); out[k] = NM(vals, k === "first_response_min" || k === "median_response_min" ? MIN_N.response : MIN_N.behavior, agg); }
    return out;
  };
  const lossOf = (set: Row[]): StaffMetrics["loss"] => {
    const rows = set.map((l) => lossBy.get(num(l["id"]))).filter((x): x is Row => !!x && x["status"] === "lost");
    const cnt: Record<string, number> = {}, st: Record<string, number> = {}, drv = { customer: 0, process: 0, unclear: 0 };
    for (const r of rows) { const k = String(r["primary_reason"]); cnt[k] = (cnt[k] ?? 0) + 1; const s = String(r["stage"]); st[s] = (st[s] ?? 0) + 1; const d = String(r["driver"]) as keyof typeof drv; if (d in drv) drv[d]++; }
    return {
      n: rows.length,
      reasons: Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([key, k]) => ({ key, label: (LOSS_LABEL as Record<string, string>)[key] ?? key, k, rate: rate(k, rows.length) })),
      stages: Object.entries(st).sort((a, b) => b[1] - a[1]).map(([stage, k]) => ({ stage, label: STAGE_LABEL[stage] ?? stage, k })),
      driver: drv,
    };
  };
  const dealStats = (ds: Row[], leadSet: Row[]) => {
    const sold = ds.filter((d) => d["status"] === "sold"), lost = ds.filter((d) => d["status"] === "lost");
    const known = sold.filter((d) => String(d["cost_source"] ?? "ledger") !== "none");
    const revenue = sold.reduce((a, d) => a + num(d["sale_price"]), 0), gp = known.reduce((a, d) => a + num(d["gross_profit"]), 0);
    const revenueKnown = known.reduce((a, d) => a + num(d["sale_price"]), 0);
    const daysArr = sold.map((d) => { const l = leadSet.find((x) => num(x["id"]) === num(d["lead_id"])); return l ? (Date.parse(String(d["closed_at"])) - Date.parse(String(l["opened_at"]))) / D : null; }).filter((x): x is number => x != null);
    return { sold: sold.length, lost: lost.length, revenue, gp, gp_known: known.length, gp_unknown: sold.length - known.length, gp_estimate: known.filter((d) => num(d["gp_is_estimate"]) === 1).length,
      avg_price: sold.length ? Math.round(revenue / sold.length) : null, avg_gp: NM(known.map((d) => num(d["gross_profit"])), MIN_N.gp_per_deal, "mean"), avg_days: daysArr.length ? Math.round(mean(daysArr)!) : null,
      below_cost: known.filter((d) => num(d["gross_profit"]) < 0).length, margin: revenueKnown ? r3(gp / revenueKnown) : null };
  };
  const mapAll = <T extends Record<string, Metric | NumMetric>>(o: T, f: (m: Metric | NumMetric) => Metric | NumMetric): T => Object.fromEntries(Object.entries(o).map(([k, m]) => [k, f(m)])) as T;

  /* ── 每位員工：訊息面的指標看「他在線上回的客戶」，成交面的指標看「指派給他的客戶」；兩者都做的人兩組幾乎一樣 ── */
  const staff: StaffMetrics[] = [];
  for (const u of agents) {
    const uid = num(u["id"]); const job = jobOf(u); const shared = !!num(u["seat_shared"]);
    const mine = leads.filter((l) => num(l["staff_id"]) === uid);
    const chatMine = leads.filter((l) => chatBy.get(num(l["id"])) === uid);
    const leadsP = mine.filter((l) => inP(l["first_real_at"])), leadsPrev = mine.filter((l) => inPrev(l["first_real_at"]));
    const chatP = chatMine.filter((l) => inP(l["first_real_at"]));
    const chatSet = job === "chat" ? chatP : leadsP;                      // 訊息面指標的母體
    const own = job === "chat" ? chatMine : mine;                          // 進行中／停滯用
    const dealsP = deals.filter((d) => num(d["staff_id"]) === uid && inP(d["closed_at"])), dealsPrev = deals.filter((d) => num(d["staff_id"]) === uid && inPrev(d["closed_at"]));
    const feats = chatSet.map((l) => featBy.get(num(l["id"]))).filter((f): f is NonNullable<typeof f> => !!f);
    const fr = feats.map((f) => f["first_response_min"]?.v).filter((v): v is number => v != null);
    const rp = feats.map((f) => f["median_response_min"]?.v).filter((v): v is number => v != null);
    let beh = behaviorsOf(chatSet);
    let firstResp = NM(fr, MIN_N.response), resp = NM(rp, MIN_N.response);
    const myRoles = roles.filter((r) => num(r["user_id"]) === uid);
    const roleLeads = (role: string) => myRoles.filter((r) => String(r["role"]) === role).map((r) => num(r["lead_id"])).filter((id) => { const l = leadById.get(id); return !!l && inP(l["first_real_at"]); });
    const supportedLeads = roleLeads("supporting");
    const inactiveLeads = chatSet.filter((l) => has(num(l["id"]), "CUSTOMER_INACTIVE"));
    const reactLeads = roleLeads("reactivation");
    const managerOn = leadsP.filter((l) => (rolesBy.get(num(l["id"])) ?? []).some((r) => r.role === "manager")).length;
    const crossTeam = supportedLeads.filter((id) => { const l = leadById.get(id); return !!l && teamOf(num(l["staff_id"])) !== String(u["team"]); }).length;
    const influencedIds = new Set(myRoles.map((r) => num(r["lead_id"])));
    const influenced = deals.filter((d) => d["status"] === "sold" && inP(d["closed_at"]) && influencedIds.has(num(d["lead_id"])));
    const open = own.filter((l) => !l["outcome"]);
    const stale = open.filter((l) => (lastStaffAt.get(num(l["id"])) ?? 0) < toT - 14 * D).length;
    const activeConv = open.filter((l) => (lastAnyAt.get(num(l["id"])) ?? 0) >= toT - 30 * D).length;
    const prices = (job === "chat" ? chatP : leadsP).map((l) => num(l["list_price"])).filter((p) => p > 0);
    const bands: Record<string, number> = {}; for (const p of prices) { const b = BAND(p); bands[b] = (bands[b] ?? 0) + 1; }
    const ds = dealStats(dealsP, mine);
    const prevF = funnelOf(leadsPrev);
    let reactRate = M(reactLeads.length, inactiveLeads.length, MIN_N.reactivation);
    let chatNote = "";
    if (shared) { chatNote = "Super 8 座位共用，個人的訊息指標只算到團隊"; beh = mapAll(beh, SHARED); firstResp = SHARED(firstResp); resp = SHARED(resp); reactRate = SHARED(reactRate); }
    if (job === "sales") { chatNote = "業務不回線上訊息，訊息面指標不適用"; beh = mapAll(beh, NA); firstResp = NA(firstResp); resp = NA(resp); reactRate = NA(reactRate); }
    if (job === "chat") chatNote = "訊息組：線上回訊息，到店後交給業務；成交面指標不適用";
    const fun = funnelOf(leadsP), funChat = funnelOf(chatSet);
    const funnel: StaffMetrics["funnel"] = job === "chat"
      ? { ...funChat, appt_visit: NA(funChat.appt_visit), visit_sale: NA(funChat.visit_sale), close: NA(funChat.close), dropoff: NA(funChat.dropoff) }
      : fun;
    staff.push({
      id: uid, name: String(u["name"]), team: String(u["team"]), job, seat_shared: shared,
      context: { leads: leadsP.length, chat_leads: chatP.length, chat_note: chatNote, open: (job === "chat" ? chatP : leadsP).filter((l) => !l["outcome"]).length, closed: (job === "chat" ? chatP : leadsP).filter((l) => !!l["outcome"]).length, median_list_price: median(prices), band: BAND(median(prices)), bands, first_seen: firstSeenBy.get(uid) ?? null, peer_note: "" },
      activity: { first_response: firstResp, response: resp, followup_24h: beh["followup_24h_rate"] as Metric, stale, handoffs_out: roleLeads("handoff_from").length, handoffs_in: roleLeads("handoff_to").length,
        reactivations: reactLeads.length, reactivation_rate: reactRate, supported: supportedLeads.length + roleLeads("chat_handler").length, manager_interventions: managerOn, cross_team_support: crossTeam, active_conversations: activeConv },
      funnel,
      commercial: { ...ds, avg_gp: job === "chat" ? NA(ds.avg_gp) : ds.avg_gp, influenced_sold: influenced.length, influenced_gp: influenced.reduce((a, d) => a + gpOf(d), 0), influenced_revenue: influenced.reduce((a, d) => a + num(d["sale_price"]), 0), discount: beh["discount_pct"] as NumMetric },
      behaviors: beh, loss: lossOf(job === "chat" ? chatP : leadsP),
      prev: { sold: dealsPrev.filter((d) => d["status"] === "sold").length, gp: dealsPrev.filter((d) => d["status"] === "sold").reduce((a, d) => a + gpOf(d), 0), close: prevF.close, leads: leadsPrev.length },
    });
  }

  lap("staff");
  /* ── 團隊（含訊息組在線上處理、還沒指派業務的客戶）── */
  const agentIds = new Set(agents.map((u) => num(u["id"])));
  const belongs = (l: Row) => agentIds.has(num(l["staff_id"])) || agentIds.has(chatBy.get(num(l["id"])) ?? -1);
  const allP = leads.filter((l) => inP(l["first_real_at"]) && belongs(l));
  const allPrev = leads.filter((l) => inPrev(l["first_real_at"]) && belongs(l));
  const teamDealsP = deals.filter((d) => inP(d["closed_at"]));
  const tds = dealStats(teamDealsP, leads);
  const teamBeh = behaviorsOf(allP);
  const teamFeats = allP.map((l) => featBy.get(num(l["id"]))).filter((f): f is NonNullable<typeof f> => !!f);
  const team: StaffReport["team"] = {
    funnel: funnelOf(allP), leads: allP.length,
    commercial: { sold: tds.sold, lost: tds.lost, revenue: tds.revenue, gp: tds.gp, gp_known: tds.gp_known, gp_unknown: tds.gp_unknown, gp_estimate: tds.gp_estimate, avg_gp: tds.avg_gp, margin: tds.margin, below_cost: tds.below_cost },
    activity: { first_response: NM(teamFeats.map((f) => f["first_response_min"]?.v).filter((v): v is number => v != null), MIN_N.response), response: NM(teamFeats.map((f) => f["median_response_min"]?.v).filter((v): v is number => v != null), MIN_N.response), followup_24h: teamBeh["followup_24h_rate"] as Metric },
    behaviors: teamBeh, loss: lossOf(allP),
    prev: { sold: deals.filter((d) => d["status"] === "sold" && inPrev(d["closed_at"])).length, gp: deals.filter((d) => d["status"] === "sold" && inPrev(d["closed_at"])).reduce((a, d) => a + gpOf(d), 0), leads: allPrev.length, close: funnelOf(allPrev).close },
  };
  // 同價位帶備註：客戶中位車價明顯偏離團隊的人，比較時要看同一價位帶
  const teamMedianPrice = median(allP.map((l) => num(l["list_price"])).filter((p) => p > 0));
  for (const s of staff) {
    if (s.context.median_list_price != null && teamMedianPrice != null && Math.abs(s.context.median_list_price - teamMedianPrice) / teamMedianPrice >= 0.35) {
      const peers = staff.filter((x) => x.id !== s.id && x.context.band === s.context.band);
      s.context.peer_note = `客戶中位車價 ${Math.round(s.context.median_list_price / 10_000)} 萬（團隊 ${Math.round(teamMedianPrice / 10_000)} 萬），屬${s.context.band}；同價位帶同儕 ${peers.length} 位${peers.length >= 2 ? `，同帶成交率 ${pct(pool(peers.map((p) => p.funnel.close)).rate)}` : "，不足以另外比"}`;
    }
  }
  const teams: StaffReport["teams"] = [...new Set(staff.map((s) => s.team))].map((name) => {
    const members = staff.filter((s) => s.team === name);
    const closedIn = members.reduce((a, s) => a + s.funnel.close.n, 0), soldIn = members.reduce((a, s) => a + s.funnel.close.k, 0);
    const handoffIn = roles.filter((r) => String(r["role"]) === "handoff_to" && teamOf(num(r["user_id"])) === name).map((r) => num(r["lead_id"]));
    const handoffSold = handoffIn.filter((id) => leadById.get(id)?.["outcome"] === "sold").length;
    return { name, staff: members.length, leads: members.reduce((a, s) => a + s.context.leads, 0), sold: members.reduce((a, s) => a + s.commercial.sold, 0), revenue: members.reduce((a, s) => a + s.commercial.revenue, 0), gp: members.reduce((a, s) => a + s.commercial.gp, 0), close: M(soldIn, closedIn, MIN_N.close), handoff_success: M(handoffSold, handoffIn.length, MIN_N.pair), cross_support: members.reduce((a, s) => a + s.activity.cross_team_support, 0) };
  });

  lap("team");
  /* ── 排名（分維度、附樣本、Wilson 排序）── */
  interface Dim { key: string; label: string; desc: string; kind: "rate" | "num"; get?: (s: StaffMetrics) => Metric; value?: (s: StaffMetrics) => number | null; n?: (s: StaffMetrics) => number; min?: number; lowerIsBetter?: boolean; fmt: "pct" | "nt" | "min" | "num"; extra?: (s: StaffMetrics) => string }
  const DIMS: Dim[] = [
    { key: "closers", label: "成交", desc: "成交率（成交 ÷ 已結案），排序用 Wilson 下界", kind: "rate", get: (s) => s.funnel.close, fmt: "pct", extra: (s) => `${s.commercial.sold} 台` },
    { key: "gp", label: "毛利", desc: "本期成交毛利合計", kind: "num", value: (s) => s.commercial.gp, n: (s) => s.commercial.sold, min: 1, fmt: "nt" },
    { key: "gp_per_deal", label: "每台毛利", desc: "平均每台成交毛利（≥3 台才排）", kind: "num", value: (s) => s.commercial.avg_gp.value, n: (s) => s.commercial.sold, min: MIN_N.gp_per_deal, fmt: "nt" },
    { key: "appt", label: "預約轉換", desc: "客戶 → 預約成立", kind: "rate", get: (s) => s.funnel.appt, fmt: "pct" },
    { key: "visit", label: "到店轉換", desc: "預約成立 → 到店", kind: "rate", get: (s) => s.funnel.appt_visit, fmt: "pct" },
    { key: "followup", label: "跟進", desc: "客戶沉默 24 小時後有跟進的比例", kind: "rate", get: (s) => s.activity.followup_24h, fmt: "pct" },
    { key: "response", label: "回覆速度", desc: "首次回覆時間中位數（越短越好）", kind: "num", value: (s) => s.activity.first_response.value, n: (s) => s.activity.first_response.n, min: MIN_N.response, lowerIsBetter: true, fmt: "min" },
    { key: "reactivation", label: "回流", desc: "沉默 ≥7 天的客戶被叫回來的比例", kind: "rate", get: (s) => s.activity.reactivation_rate, fmt: "pct" },
    { key: "team", label: "團隊貢獻", desc: "支援別人的案子＋接手交接＋回流（次數）", kind: "num", value: (s) => s.activity.supported + s.activity.handoffs_in + s.activity.reactivations, n: (s) => s.activity.supported + s.activity.handoffs_in + s.activity.reactivations, min: 1, fmt: "num" },
  ];
  const fmtV = (v: number | null, f: Dim["fmt"]) => (v == null ? "—" : f === "pct" ? pct(v) : f === "nt" ? `NT$ ${Math.round(v).toLocaleString("zh-TW")}` : f === "min" ? `${Math.round(v)} 分鐘` : String(Math.round(v)));
  /** 不適用的維度不列（訊息組沒有毛利、純業務沒有回覆速度），不是「資料不足」 */
  const naFor = (d: Dim, s: StaffMetrics) => d.kind === "rate" ? !!d.get!(s).na : d.key === "response" ? !!s.activity.first_response.na : (d.key === "gp" || d.key === "gp_per_deal") ? s.job === "chat" : false;
  const rankings = DIMS.map((d) => {
    const rows: RankRow[] = staff.filter((s) => !naFor(d, s)).map((s) => {
      if (d.kind === "rate") { const m = d.get!(s); return { staff_id: s.id, name: s.name, team: s.team, value: m.rate, display: `${pct(m.rate)}${d.extra ? ` · ${d.extra(s)}` : ""}`, k: m.k, n: m.n, ok: m.ok, rank: null, _sort: m.low } as RankRow & { _sort: number }; }
      const v = d.value!(s), n = d.n!(s); return { staff_id: s.id, name: s.name, team: s.team, value: v, display: fmtV(v, d.fmt), k: n, n, ok: n >= (d.min ?? 1) && v != null && !(d.key === "response" && s.activity.first_response.shared), rank: null, _sort: v == null ? -Infinity : d.lowerIsBetter ? -v : v } as RankRow & { _sort: number };
    });
    const ok = rows.filter((r) => r.ok).sort((a, b) => (b as RankRow & { _sort: number })._sort - (a as RankRow & { _sort: number })._sort);
    ok.forEach((r, i) => { r.rank = i + 1; });
    const out = [...ok, ...rows.filter((r) => !r.ok)].map(({ _sort: _s, ...rest }: RankRow & { _sort?: number }) => rest);
    return { key: d.key, label: d.label, desc: d.desc, rows: out };
  });
  const rankOf = (key: string, id: number) => rankings.find((r) => r.key === key)?.rows.find((x) => x.staff_id === id)?.rank ?? null;

  /* ── 表現最佳 ── */
  const eligible = staff.filter((s) => s.funnel.close.ok);
  const topN = Math.min(5, Math.max(3, Math.round(staff.length * 0.4)));
  const topSorted = [...eligible].sort((a, b) => b.funnel.close.low - a.funnel.close.low || b.commercial.gp - a.commercial.gp).slice(0, topN);
  const strengthOf = (s: StaffMetrics): string => {
    const firsts = DIMS.filter((d) => rankOf(d.key, s.id) === 1).map((d) => d.label);
    if (firsts.length) return `${firsts.slice(0, 2).join("、")}第一`;
    const best = DIMS.map((d) => ({ d, r: rankOf(d.key, s.id) })).filter((x) => x.r != null).sort((a, b) => a.r! - b.r!)[0];
    return best ? `${best.d.label}第 ${best.r} 名` : "樣本不足";
  };
  const reasonOf = (s: StaffMetrics): string => {
    const parts: string[] = [];
    if (s.funnel.visit_sale.ok && s.funnel.visit_sale.rate != null && team.funnel.visit_sale.rate != null && s.funnel.visit_sale.rate >= team.funnel.visit_sale.rate + 0.1) parts.push(`到店→成交 ${pct(s.funnel.visit_sale.rate)}（團隊 ${pct(team.funnel.visit_sale.rate)}）`);
    if (s.funnel.price_continue.ok && s.funnel.price_continue.rate != null && team.funnel.price_continue.rate != null && s.funnel.price_continue.rate >= team.funnel.price_continue.rate + 0.1) parts.push(`報價後續走 ${pct(s.funnel.price_continue.rate)}（團隊 ${pct(team.funnel.price_continue.rate)}）`);
    if (s.commercial.avg_gp.ok && team.commercial.avg_gp.value != null && s.commercial.avg_gp.value != null && s.commercial.avg_gp.value >= team.commercial.avg_gp.value * 1.2) parts.push(`每台毛利 ${wan(s.commercial.avg_gp.value)}（團隊 ${wan(team.commercial.avg_gp.value)}）`);
    if (s.activity.first_response.ok && team.activity.first_response.value != null && s.activity.first_response.value != null && s.activity.first_response.value <= team.activity.first_response.value * 0.5) parts.push(`首次回覆 ${Math.round(s.activity.first_response.value)} 分鐘（團隊 ${Math.round(team.activity.first_response.value)}）`);
    if (s.activity.reactivations >= 2) parts.push(`救回 ${s.activity.reactivations} 位沉默客戶`);
    return parts.length ? parts.slice(0, 2).join("；") : `成交率 ${pct(s.funnel.close.rate)}（${s.funnel.close.k}/${s.funnel.close.n}），團隊 ${pct(team.funnel.close.rate)}`;
  };
  const top = topSorted.map((s, i) => ({
    rank: i + 1, staff_id: s.id, name: s.name, team: s.team, reason: reasonOf(s), strength: strengthOf(s),
    sold: s.commercial.sold, close: s.funnel.close, revenue: s.commercial.revenue, gp: s.commercial.gp, avg_gp: s.commercial.avg_gp.value, appts: s.funnel.booked, visits: s.funnel.visited, influenced: s.commercial.influenced_sold,
    trend: { sold: s.commercial.sold - s.prev.sold, close: s.funnel.close.rate != null && s.prev.close.rate != null ? r3(s.funnel.close.rate - s.prev.close.rate) : null },
  }));

  /* ── 需要關注（只在樣本夠、且明確低於團隊時出現）── */
  interface Flag { key: string; text: string; mine: number | null; team: number | null; n: number; severity: number; pattern: string; coaching: string; affected: (s: StaffMetrics) => number }
  const flagsOf = (s: StaffMetrics): Flag[] => {
    const f: Flag[] = [];
    const t = team;
    const gapRate = (mine: Metric, tm: Metric, key: string, label: string, min: number, pattern: (s: StaffMetrics) => string, coaching: string, affected: (s: StaffMetrics) => number) => {
      if (mine.ok && tm.rate != null && mine.rate != null && mine.rate <= tm.rate - min) f.push({ key, text: `${label} ${pct(mine.rate)}（${mine.k}/${mine.n}），團隊 ${pct(tm.rate)}`, mine: mine.rate, team: tm.rate, n: mine.n, severity: (tm.rate - mine.rate) / min, pattern: pattern(s), coaching, affected });
    };
    gapRate(s.funnel.price_continue, t.funnel.price_continue, "price_continue", "報價後續走", 0.1,
      (x) => behText(x, "asked_after_price", "報價後接一個問題") || behText(x, "objection_clarified", "價格異議後先釐清") || "報價後對話常常就停了",
      "報價後接一個診斷式問題（預算／月付或總價／舊車換購），客戶沒回就在 24 小時內跟進，不要只丟數字。", (x) => x.funnel.price_continue.n - x.funnel.price_continue.k);
    gapRate(s.funnel.close, t.funnel.close, "close", "成交率", 0.1, (x) => x.loss.stages[0] ? `客戶最常在「${x.loss.stages[0].label}」之後消失` : "已結案客戶多數未成交", "先看流失原因矩陣裡最高的一格，從那個階段的話術與跟進開始改。", (x) => x.funnel.close.n - x.funnel.close.k);
    gapRate(s.funnel.appt, t.funnel.appt, "appt", "預約轉換", 0.1, (x) => behText(x, "proposed_after_intent", "高意圖後主動約看車") || "很少主動提出看車時間", "客戶表達急迫或問「什麼時候可以看車」時，當下就給兩個時段讓客戶選。", (x) => x.funnel.appt.n - x.funnel.appt.k);
    gapRate(s.funnel.appt_visit, t.funnel.appt_visit, "appt_visit", "預約→到店", 0.15, () => "預約成立後到店的比例偏低", "預約前一天用 LINE 再確認一次，沒回覆的當天早上打電話；爽約後兩天內重新約。", (x) => x.funnel.appt_visit.n - x.funnel.appt_visit.k);
    gapRate(s.funnel.visit_sale, t.funnel.visit_sale, "visit_sale", "到店→成交", 0.15, (x) => behText(x, "postvisit_24h", "到店後 24 小時內跟進") || "到店後沒有當場成交的客戶多數沒再回來", "到店當天結束前發一則整理訊息（今天看的車、價格、下一步），24 小時內再跟進一次。", (x) => x.funnel.visit_sale.n - x.funnel.visit_sale.k);
    gapRate(s.activity.followup_24h, t.activity.followup_24h, "followup", "沉默後跟進", 0.2, () => "客戶沒回之後常常就沒有下文", "客戶沉默 24 小時就跟進一次、72 小時再一次；用「看車時段」或「新資訊」去敲，不要問「考慮得怎樣」。", (x) => x.activity.followup_24h.n - x.activity.followup_24h.k);
    if (s.activity.first_response.ok && t.activity.first_response.value != null && s.activity.first_response.value != null && s.activity.first_response.value >= Math.max(30, t.activity.first_response.value * 2))
      f.push({ key: "response", text: `首次回覆中位數 ${Math.round(s.activity.first_response.value)} 分鐘（n=${s.activity.first_response.n}），團隊 ${Math.round(t.activity.first_response.value)} 分鐘`, mine: s.activity.first_response.value, team: t.activity.first_response.value, n: s.activity.first_response.n, severity: s.activity.first_response.value / Math.max(1, t.activity.first_response.value) - 1, pattern: "客戶第一則訊息常常隔很久才有人回", coaching: "新進線 15 分鐘內先回一句（在的、車還在、方便問預算嗎），細節之後補。", affected: (x) => x.loss.reasons.find((r) => r.key === "slow_response")?.k ?? 0 });
    return f.sort((a, b) => b.severity - a.severity);
  };
  const behText = (s: StaffMetrics, key: string, label: string): string => {
    const m = s.behaviors[key] as Metric | undefined, tm = team.behaviors[key] as Metric | undefined;
    if (!m || !tm || !m.ok || m.rate == null || tm.rate == null || m.rate > tm.rate - 0.15) return "";
    return `${label}的比例 ${pct(m.rate)}（${m.k}/${m.n}），團隊 ${pct(tm.rate)}`;
  };
  const watchCands = staff.filter((s) => s.funnel.close.n >= MIN_N.close || s.context.leads >= MIN_N.close || s.context.chat_leads >= MIN_N.close).map((s) => ({ s, flags: flagsOf(s) })).filter((x) => x.flags.length).sort((a, b) => b.flags.reduce((p, q) => p + q.severity, 0) - a.flags.reduce((p, q) => p + q.severity, 0));
  const issues: Record<number, Issue[]> = Object.fromEntries(staff.map((s) => [s.id, flagsOf(s).map(({ affected, ...f }) => ({ ...f, affected: affected(s) }))]));
  const watchN = Math.min(3, Math.max(1, Math.round(staff.length * 0.25)));
  const watch = watchCands.slice(0, watchN).filter((x) => !topSorted.some((t) => t.id === x.s.id)).map(({ s, flags }) => {
    const main = flags[0]!;
    const lostAt = s.loss.stages[0];
    const lostLeadIds = leads.filter((l) => num(l["staff_id"]) === s.id && inP(l["first_real_at"]) && l["outcome"] === "lost").map((l) => num(l["id"]));
    const processLosses = lostLeadIds.filter((id) => lossBy.get(id)?.["driver"] === "process").length;
    return {
      staff_id: s.id, name: s.name, team: s.team, rank_closers: rankOf("closers", s.id), leads: s.context.leads, sold: s.commercial.sold, close: s.funnel.close, gp: s.commercial.gp,
      lost_stage: lostAt ? `${lostAt.label}（${lostAt.k}/${s.loss.n}）` : "資料不足",
      response: s.activity.first_response.ok ? `首次回覆中位數 ${Math.round(s.activity.first_response.value!)} 分鐘（團隊 ${Math.round(team.activity.first_response.value ?? 0)}）` : "資料不足",
      followup: s.activity.followup_24h.ok ? `沉默後跟進 ${pct(s.activity.followup_24h.rate)}（團隊 ${pct(team.activity.followup_24h.rate)}）` : "資料不足",
      issue: { key: main.key, text: main.text, mine: main.mine, team: main.team, n: main.n }, pattern: main.pattern, coaching: main.coaching,
      evidence: { affected_leads: main.affected(s), lead_ids: lostLeadIds.slice(0, 8), process_losses: processLosses },
    };
  });

  /* ── 成功 vs 需關注：行為對照（觀察到的關聯）── */
  const topIds = topSorted.map((s) => s.id), watchIds = watch.map((w) => w.staff_id);
  const poolLeads = (ids: number[]) => allP.filter((l) => ids.includes(num(l["staff_id"])) || ids.includes(chatBy.get(num(l["id"])) ?? -1));
  const topBeh = behaviorsOf(poolLeads(topIds)), watchBeh = behaviorsOf(poolLeads(watchIds));
  const topFun = funnelOf(poolLeads(topIds)), watchFun = funnelOf(poolLeads(watchIds));
  const observations: Observation[] = [];
  for (const [key, meta] of Object.entries(FEATURE_LABEL)) {
    const a = topBeh[key], b = watchBeh[key], t = teamBeh[key]; if (!a || !b || !t) continue;
    const isRate = "rate" in a;
    const av = isRate ? (a as Metric).rate : (a as NumMetric).value, bv = isRate ? (b as Metric).rate : (b as NumMetric).value, tv = isRate ? (t as Metric).rate : (t as NumMetric).value;
    const an = a.n, bn = b.n;
    if (av == null || bv == null || an < MIN_N.behavior || bn < MIN_N.behavior) continue;
    const delta = r3(av - bv);
    const notable = isRate ? Math.abs(delta) >= 0.15 : (meta.unit === "min" ? Math.max(av, bv) / Math.max(1, Math.min(av, bv)) >= 1.8 : Math.abs(delta) >= 0.02);
    if (!notable) continue;
    const fmt = (v: number) => (isRate ? pct(v) : meta.unit === "min" ? `${Math.round(v)} 分鐘` : meta.unit === "pct" ? pct(v) : String(Math.round(v * 10) / 10));
    observations.push({ feature: key, label: meta.label, unit: meta.unit, top: av, watch: bv, team: tv, n_top: an, n_watch: bn, delta, claim: "correlation",
      text: `表現最佳組「${meta.label}」${fmt(av)}（n=${an}），需關注組 ${fmt(bv)}（n=${bn}），團隊 ${tv == null ? "—" : fmt(tv)}` });
  }
  observations.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const goodDeltas = observations.filter((o) => (FEATURE_LABEL[o.feature]?.goodIsUp ? (o.delta ?? 0) > 0 : (o.delta ?? 0) < 0)).slice(0, 3).map((o) => `「${o.label}」`);
  const summary = watchIds.length && topIds.length
    ? (goodDeltas.length ? `在相同情境下，表現最佳的人比較常做到 ${goodDeltas.join("、")}。這是觀察到的關聯，不是因果；樣本見各列 n。` : "兩組在可比較的行為上差異不大；差異可能來自客戶量、車價帶或運氣，先不要下結論。")
    : "需關注組目前沒有人達到門檻，無法對照。";
  const compareFunnel = (["price_continue", "appt", "appt_visit", "visit_sale", "close"] as const).map((k) => ({ key: k, label: { price_continue: "報價後續走", appt: "預約轉換", appt_visit: "預約→到店", visit_sale: "到店→成交", close: "成交率" }[k], top: topFun[k], watch: watchFun[k], team: team.funnel[k] }));

  /* ── 行為 × 結果的關聯（全團隊、以 lead 計）── */
  const closedP = allP.filter((l) => !!l["outcome"]);
  const associations: StaffReport["associations"] = [];
  for (const key of RATE_FEATURES) {
    if (key === "followup_24h_rate") continue;
    const withF = closedP.filter((l) => (featBy.get(num(l["id"]))?.[key]?.v ?? null) === 1), without = closedP.filter((l) => (featBy.get(num(l["id"]))?.[key]?.v ?? null) === 0);
    const a = M(withF.filter((l) => l["outcome"] === "sold").length, withF.length, MIN_N.behavior), b = M(without.filter((l) => l["outcome"] === "sold").length, without.length, MIN_N.behavior);
    if (!a.n && !b.n) continue;
    associations.push({ feature: key, label: FEATURE_LABEL[key]?.label ?? key, with: a, without: b, lift: a.rate != null && b.rate != null ? r3(a.rate - b.rate) : null });
  }
  { // 快速首次回覆（≤15 分鐘）當成布林特徵
    const fast = closedP.filter((l) => { const v = featBy.get(num(l["id"]))?.["first_response_min"]?.v; return v != null && v <= 15; }), slow = closedP.filter((l) => { const v = featBy.get(num(l["id"]))?.["first_response_min"]?.v; return v != null && v > 15; });
    const a = M(fast.filter((l) => l["outcome"] === "sold").length, fast.length, MIN_N.behavior), b = M(slow.filter((l) => l["outcome"] === "sold").length, slow.length, MIN_N.behavior);
    associations.push({ feature: "fast_first_response", label: "首次回覆 ≤15 分鐘", with: a, without: b, lift: a.rate != null && b.rate != null ? r3(a.rate - b.rate) : null });
  }

  /* ── 成功模式庫 ── */
  const PATTERN_DEFS: Array<{ key: string; label: string; what: string; feature?: string; threshold?: number; numeric?: string; max?: number; funnel?: keyof StaffMetrics["funnel"]; assoc: string }> = [
    { key: "fast_first_response", label: "快速首次回覆", what: "客戶第一則訊息 15 分鐘內先回一句", numeric: "first_response_min", max: 15, assoc: "fast_first_response" },
    { key: "question_after_price", label: "報價後接一個問題", what: "報價後不等客戶反應，先問預算／月付或總價／舊車", feature: "asked_after_price", threshold: 0.6, assoc: "asked_after_price" },
    { key: "objection_recovery", label: "價格異議後先釐清", what: "客戶說太貴時先問心中數字或考量點，再談方案", feature: "objection_clarified", threshold: 0.6, assoc: "objection_clarified" },
    { key: "intent_to_appointment", label: "高意圖立刻約看車", what: "客戶表達急迫的 48 小時內主動給看車時段", feature: "proposed_after_intent", threshold: 0.6, assoc: "proposed_after_intent" },
    { key: "financing_explanation", label: "貸款講得具體", what: "頭期、月付、利率給數字或直接轉專員", feature: "fin_answered", threshold: 0.7, assoc: "fin_answered" },
    { key: "postvisit_followup", label: "到店後 24 小時內跟進", what: "沒當場成交的到店客戶，隔天前就有整理訊息", feature: "postvisit_24h", threshold: 0.7, assoc: "postvisit_24h" },
    { key: "reactivation", label: "把沉默客戶叫回來", what: "客戶沉默一週以上，用新資訊或看車時段敲回來", feature: "reactivated_by_staff", threshold: 0.3, assoc: "reactivated_by_staff" },
    { key: "visit_to_sale", label: "到店後成交強", what: "到店的客戶多數成交", funnel: "visit_sale", threshold: 0.7, assoc: "" },
    { key: "margin_preservation", label: "守住毛利", what: "成交折讓平均不超過定價 3%", numeric: "discount_pct", max: 0.03, assoc: "" },
    { key: "team_collaboration", label: "找主管或同事協助", what: "遇到專業問題或價格僵局時拉人進來", feature: "escalated", threshold: 0.15, assoc: "escalated" },
  ];
  const patterns: Pattern[] = [];
  for (const p of PATTERN_DEFS) {
    const who: Pattern["staff"] = [];
    for (const s of staff) {
      if (p.feature) { const m = s.behaviors[p.feature] as Metric | undefined; if (m && m.ok && m.rate != null && m.rate >= (p.threshold ?? 0)) who.push({ id: s.id, name: s.name, value: m.rate, n: m.n }); }
      else if (p.numeric) { const m = s.behaviors[p.numeric] as NumMetric | undefined; if (m && m.ok && m.value != null && m.value <= (p.max ?? Infinity)) who.push({ id: s.id, name: s.name, value: m.value, n: m.n }); }
      else if (p.funnel) { const m = s.funnel[p.funnel] as Metric; if (m.ok && m.rate != null && m.rate >= (p.threshold ?? 0)) who.push({ id: s.id, name: s.name, value: m.rate, n: m.n }); }
    }
    const assoc = associations.find((a) => a.feature === p.assoc) ?? null;
    const nTotal = who.reduce((a, w) => a + w.n, 0);
    // 代表證據：示範者成交案裡有這個特徵的訊息
    const ev: Pattern["evidence"] = [];
    if (p.feature || p.numeric) {
      for (const l of allP) {
        if (ev.length >= 3) break;
        if (l["outcome"] !== "sold" || !who.some((w) => w.id === num(l["staff_id"]))) continue;
        const f = featBy.get(num(l["id"])); const x = p.feature ? f?.[p.feature] : f?.[p.numeric!];
        const hit = x && x.v != null && (p.feature ? x.v >= 1 : x.v <= (p.max ?? Infinity));
        if (hit) ev.push({ lead_id: num(l["id"]), message_id: x!.msg ?? null, contact: String(l["contact"]), staff: String(userById.get(num(l["staff_id"]))?.["name"] ?? "") });
      }
    }
    patterns.push({ key: p.key, label: p.label, what: p.what, staff: who.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)), n_total: nTotal, outcome: assoc ? { with: assoc.with, without: assoc.without, lift: assoc.lift } : null, evidence: ev, confidence: nTotal >= 20 ? "STRONGLY_SUGGESTED" : nTotal >= 8 ? "POSSIBLE" : "UNCLEAR", claim: "correlation" });
  }

  /* ── 員工 × 流失原因矩陣 ── */
  const teamLoss = team.loss;
  const reasonsCols = teamLoss.reasons.map((r) => ({ key: r.key, label: r.label, team_k: r.k, team_rate: r.rate }));
  const matrix = {
    reasons: reasonsCols, team_n: teamLoss.n,
    rows: staff.map((s) => ({ staff_id: s.id, name: s.name, n: s.loss.n, cells: Object.fromEntries(reasonsCols.map((c) => { const cell = s.loss.reasons.find((r) => r.key === c.key); const rt = cell?.rate ?? (s.loss.n ? 0 : null); return [c.key, { k: cell?.k ?? 0, rate: rt, flag: s.loss.n >= MIN_N.behavior && rt != null && c.team_rate != null && rt >= c.team_rate + 0.1 }]; })) })),
  };

  /* ── 協作組合（關聯）── */
  const pairMap = new Map<string, { a: number; b: number; cases: Set<number>; sold: number }>();
  for (const [lid, rs] of rolesBy) {
    const l = leadById.get(lid); if (!l || !inP(l["first_real_at"])) continue;
    const people = [...new Set(rs.map((r) => r.uid))].filter((uid) => userById.has(uid)).sort((a, b) => a - b);
    for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
      const k = `${people[i]}-${people[j]}`; if (!pairMap.has(k)) pairMap.set(k, { a: people[i]!, b: people[j]!, cases: new Set(), sold: 0 });
      const p = pairMap.get(k)!; if (!p.cases.has(lid)) { p.cases.add(lid); if (l["outcome"] === "sold") p.sold++; }
    }
  }
  const pairs: StaffReport["pairs"] = [...pairMap.values()].filter((p) => p.cases.size >= MIN_N.pair).map((p) => ({ a: String(userById.get(p.a)?.["name"] ?? ""), b: String(userById.get(p.b)?.["name"] ?? ""), a_id: p.a, b_id: p.b, cases: p.cases.size, sold: p.sold, rate: p.cases.size >= MIN_N.pair_rate ? rate(p.sold, p.cases.size) : null, label: "association" as const })).sort((x, y) => y.cases - x.cases);

  return {
    period: { from: new Date(fromT).toISOString(), to: new Date(toT).toISOString(), days }, prev: { from: new Date(pFromT).toISOString(), to: new Date(fromT).toISOString() },
    staff: staff.sort((a, b) => b.commercial.gp - a.commercial.gp), team, teams, rankings, top, watch,
    compare: { top_ids: topIds, watch_ids: watchIds, observations, summary, funnel: compareFunnel }, associations, patterns, matrix, pairs, issues, n_agents: staff.length,
    timings: (lap("rest"), timings),
  };
}

/* ── 小工具（也給 coaching.ts 用）── */
export const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
export const wan = (n: number) => `${Math.round(n / 10_000).toLocaleString("zh-TW")} 萬`;
export function pool(ms: Metric[]): Metric { const k = ms.reduce((a, m) => a + m.k, 0), n = ms.reduce((a, m) => a + m.n, 0); return M(k, n, 1); }
export { PROCESS_REASONS };
