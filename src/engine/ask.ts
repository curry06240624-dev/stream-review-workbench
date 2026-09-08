/**
 * 問 AI 引擎 —— 三段式，AI 不碰算術：
 *   1. 規則判斷意圖（價格流失／業務／車款／預約／成交／今天該做什麼／整體）、期間、有沒有點名某個業務或車款
 *   2. 決定性分析：關鍵數據、受影響客戶、證據（已成立的洞察）、建議動作 —— 全部普通程式算出來，每個數字都能點回去
 *   3. AI 只把結論講成人話、補「可能的原因」（一律標假設）；文字裡出現事實包沒有的數字 → 那句退回規則版
 * 回答結構固定：結論 → 關鍵數據 → 原因／假設 → 受影響客戶 → 證據 → 建議行動 → 我怎麼算的。
 */
import { computeAnalytics, type Analytics } from "./analytics.ts";
import type { DbLike } from "../adapters/import.ts";
import { gemini, factsPack, violates, numbersIn } from "./ai.ts";
import { computeStaffReport, pct as pctS, wan as wanS, type StaffReport, type StaffMetrics, type Metric } from "./staff.ts";
import { buildCoachingPlan, computeDecisions } from "./coaching.ts";
import { lossAggregate, LOSS_LABEL } from "./loss.ts";
import { FEATURE_LABEL } from "./behavior.ts";

type Row = Record<string, unknown>;
interface Env { GEMINI_API_KEY?: string; GEMINI_MODEL?: string; }
export type Intent = "overview" | "price_dropoff" | "staff" | "vehicle" | "appointments" | "deals" | "attention" | "staff_compare" | "coaching" | "loss_reasons" | "decisions" | "coaching_result";
export interface AskNumber { label: string; value: string; sub?: string; href?: string }
export interface AskChart { type: "bar" | "line"; labels: string[]; series: Array<{ label: string; data: number[]; style?: "bar" | "line"; tone?: "neutral" | "warn" | "accent" }> }
export interface AskAnswer {
  question: string; intent: Intent; period: { days: number; from: string; to: string };
  conclusion: string; numbers: AskNumber[];
  reasons: Array<{ text: string; claim: "fact" | "hypothesis" | "correlation" }>;
  leads: Array<{ id: number; contact: string; staff: string; vehicle: string; note: string }>;
  evidence: Array<{ id: number; title: string; severity: string }>;
  actions: Array<{ text: string; owner_role: string }>;
  how: string[]; chart: AskChart | null; suggest: string[]; mode: "ai" | "template";
  /** 額外區塊（例如訊息改寫範例、決策卡），畫面照 title + lines 渲染 */
  extras?: Array<{ title: string; lines: string[]; href?: string }>;
}
type Built = Pick<AskAnswer, "conclusion" | "numbers" | "reasons" | "leads" | "evidence" | "actions" | "how" | "chart"> & { extras?: AskAnswer["extras"] };
interface Ctx { db: DbLike; a: Analytics; q: string; days: number; by: "staff" | "vehicle" | null; staffName: string | null; vehName: string | null; insights: Row[]; staffNames: string[]; now: string }

const D = 86_400_000, TZ = 8 * 3_600_000;
const num = (v: unknown) => Number(v ?? 0) || 0;
const P = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const W = (n: number) => `${Math.round(n / 10000).toLocaleString("zh-TW")} 萬`;
const md = (iso: string) => { const d = new Date(Date.parse(iso) + TZ); return `${d.getUTCMonth() + 1}/${String(d.getUTCDate()).padStart(2, "0")}`; };
const hrs = (iso: string, nowIso?: string) => Math.max(0, Math.round(((nowIso ? Date.parse(nowIso) : Date.now()) - Date.parse(iso)) / 3_600_000));
const enc = (s: string) => encodeURIComponent(s);
const CONF: Record<string, string> = { CONFIRMED: "確定", STRONGLY_SUGGESTED: "強烈建議", POSSIBLE: "可能", UNCLEAR: "不確定" };
const KIND: Record<string, string> = { high_intent_no_followup: "急迫未跟進", price_dropoff_no_followup: "報價後未跟進", booked_but_no_visit: "預約已過未到店", financing_unresolved: "貸款未回覆" };
const LOST_REASON: Record<string, string> = { no_response: "沒有回應", price: "價格", financing: "貸款沒過", changed_mind: "改變主意", bought_elsewhere: "別家買了", vehicle: "車況／車款", unknown: "未標記" };
const BODY_TYPE: Record<string, string> = { suv: "休旅", sedan: "轎車", hatch: "掀背", mpv: "MPV", pickup: "皮卡", wagon: "旅行車", coupe: "跑車" };
const PAIR: Record<string, string> = { price_to_booking: "報價→預約", booking_to_visit: "預約→到店", visit_to_sold: "到店→成交", lead_to_sold: "進線→成交", price_to_sold: "報價→成交" };

/* ── 1. 意圖 ── */
export function parseDays(q: string): number {
  if (/今天|今日/.test(q)) return 1;
  if (/昨天/.test(q)) return 2;
  if (/兩週|2 ?週|14 ?天|半個月/.test(q)) return 14;
  if (/這個月|本月|上個月|一個月|30 ?天|月/.test(q)) return 30;
  return 7;
}
export function topicOf(q: string): Intent {
  if (/決定|決策/.test(q)) return "decisions";
  if (/(改善|進步|有沒有用|有效|成效).*(教練|教過|上個月|之前)|(教練|教過|上個月|之前).*(改善|進步|有沒有用|有效|成效)/.test(q)) return "coaching_result";
  if (/怎麼改|如何改|改進|該改|教練|話術|範例|怎麼寫|訊息.*(改|建議)|該教|教全|教大家|哪些行為|值得教/.test(q)) return "coaching";
  if (/比較|差別|差在哪|不一樣|做了什麼|為什麼.*比|最好的|前三|後三|top|哪些.*模式|溝通|組合|一起成交|誰最會|誰最|哪個業務最|表現最/i.test(q)) return "staff_compare";
  if (/沒買|不買|沒有買|流失原因|為什麼.*流失|原因.*(增加|上升|變多)|(貸款|價格|爽約|車況).*(造成|導致).*流失|不轉換|沒有轉換|沒成交.*原因|為什麼.*沒成交|流失.*(最多|最大)/.test(q)) return "loss_reasons";
  if (/該做什麼|該先|先處理|先做|優先|要注意|待辦|今天要|誰沒|沒人跟|沒跟進|未跟進|漏掉/.test(q)) return "attention";
  if (/報價|價格|價錢|開價|流失|不回|沒回|已讀|太貴|殺價|議價/.test(q)) return "price_dropoff";
  if (/預約|到店|爽約|看車|來店|沒來/.test(q)) return "appointments";
  if (/成交|營收|毛利|賺|賣了|賣出|業績|低於成本|虧/.test(q)) return "deals";
  return "overview";
}

/* ── 共用 ── */
const LEAD = `SELECT l.id, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact, COALESCE(u.name,'未指派') AS staff, COALESCE(v.brand||' '||v.model,'') AS vehicle
  FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = l.staff_id LEFT JOIN vehicles v ON v.id = l.vehicle_id`;
const lead = (r: Row, note: string) => ({ id: num(r["id"]), contact: String(r["contact"] ?? ""), staff: String(r["staff"] ?? ""), vehicle: String(r["vehicle"] ?? ""), note });
const pick = (ins: Row[], re: RegExp, n = 3) => ins.filter((i) => re.test(`${i["kind"]} ${i["title"]}`)).slice(0, n).map((i) => ({ id: num(i["id"]), title: String(i["title"]), severity: String(i["severity"]) }));
const hypos = (ins: Row[], ids: number[]) => ins.filter((i) => ids.includes(num(i["id"]))).map((i) => String(i["summary"] ?? "").split("\n假設：")[1]).filter((t): t is string => !!t).map((t) => ({ text: t, claim: "hypothesis" as const }));
const periodLine = (a: Analytics) => `期間：最近 ${a.period.days} 天（${md(a.period.from)}～${md(a.period.to)}），對照前 ${a.period.days} 天（${md(a.prev.from)}～${md(a.prev.to)}）`;
const staffHref = (n: string) => `/conversations?staff=${enc(n)}`;
const vehHref = (n: string) => `/conversations?vehicle=${enc(n)}`;

async function weekly(db: DbLike, weeks = 8, nowIso?: string) {
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const out: Array<{ week_end: string; priced: number; dropoff: number; booked: number; visits: number; sold: number; gp: number }> = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const to = new Date(now - i * 7 * D).toISOString(), from = new Date(now - (i + 1) * 7 * D).toISOString();
    const ev = await db.all(`SELECT type, COUNT(*) AS n FROM funnel_events WHERE at >= ? AND at < ? AND confidence <> 'UNCLEAR' AND type IN ('PRICE_MENTIONED','PRICE_DROP_OFF','APPOINTMENT_BOOKED','STORE_VISIT') GROUP BY type`, from, to);
    const e: Record<string, number> = Object.fromEntries(ev.map((r) => [String(r["type"]), num(r["n"])]));
    const d = await db.first(`SELECT SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold, SUM(CASE WHEN status='sold' THEN gross_profit ELSE 0 END) AS gp FROM deals WHERE closed_at >= ? AND closed_at < ?`, from, to);
    out.push({ week_end: to.slice(5, 10), priced: e["PRICE_MENTIONED"] ?? 0, dropoff: e["PRICE_DROP_OFF"] ?? 0, booked: e["APPOINTMENT_BOOKED"] ?? 0, visits: e["STORE_VISIT"] ?? 0, sold: num(d?.["sold"]), gp: num(d?.["gp"]) });
  }
  return out;
}

/* ── 2. 各意圖的決定性分析 ── */
async function priceDropoff(c: Ctx): Promise<Built> {
  const { a, db } = c; const pd = a.price_dropoff;
  const dim = c.by === "vehicle" ? pd.by_vehicle.map((x) => ({ label: x.vehicle, ...x })) : pd.by_staff.map((x) => ({ label: x.staff, ...x }));
  const ranked = dim.filter((x) => x.priced >= 3 && x.rate != null).sort((x, y) => num(y.rate) - num(x.rate));
  const worst = ranked[0];
  const focus = c.staffName ? pd.by_staff.find((x) => x.staff === c.staffName) : c.vehName ? pd.by_vehicle.find((x) => x.vehicle === c.vehName) : null;
  const ptb = a.conversion["price_to_booking"];
  const numbers: AskNumber[] = [
    { label: "報價", value: `${pd.base} 次`, sub: `前期 ${pd.prev_base}`, href: "/conversations?event=PRICE_MENTIONED" },
    { label: "報價後未再回覆", value: `${pd.count} 位`, sub: `前期 ${pd.prev_count}`, href: "/conversations?flag=price_dropoff" },
    { label: "流失率", value: P(pd.rate), sub: `前期 ${P(pd.prev_rate)}`, href: "/funnel" },
    { label: "報價→預約", value: P(ptb?.rate), sub: `n=${ptb?.n ?? 0}`, href: "/funnel" },
  ];
  if (focus) numbers.push({ label: c.staffName ?? c.vehName ?? "", value: `${focus.dropped}/${focus.priced}（${P(focus.rate)}）`, href: `/conversations?flag=price_dropoff&${c.staffName ? "staff" : "vehicle"}=${enc(c.staffName ?? c.vehName ?? "")}` });
  const reasons: Built["reasons"] = [];
  if (worst) reasons.push({ text: `${c.by === "vehicle" ? "車款" : "業務"}分項裡 ${worst.label} 最高：報價 ${worst.priced} 次流失 ${worst.dropped} 位（${P(worst.rate)}）。`, claim: "fact" });
  const bt = pd.by_body_type.filter((x) => x.priced >= 3 && x.rate != null).sort((x, y) => num(y.rate) - num(x.rate))[0];
  if (bt) reasons.push({ text: `車型裡 ${BODY_TYPE[bt.body_type] ?? (bt.body_type || "未分類")} 流失率最高（${P(bt.rate)}，n=${bt.priced}）。`, claim: "fact" });
  const evidence = pick(c.insights, /price_dropoff|報價|價格|流失/i);
  reasons.push(...hypos(c.insights, evidence.map((e) => e.id)));
  const where: string[] = []; const args: unknown[] = [a.period.from, a.period.to];
  if (c.staffName) { where.push("x.staff = ?"); args.push(c.staffName); }
  if (c.vehName) { where.push("x.vehicle = ?"); args.push(c.vehName); }
  const rows = await db.all(`SELECT x.*, e.at, e.confidence FROM (${LEAD}) x JOIN funnel_events e ON e.lead_id = x.id AND e.type = 'PRICE_DROP_OFF' AND e.confidence IN ('CONFIRMED','STRONGLY_SUGGESTED')
    WHERE e.at >= ? AND e.at < ?${where.map((w) => ` AND ${w}`).join("")} ORDER BY e.at DESC LIMIT 8`, ...args);
  const leads = rows.map((r) => lead(r, `${md(String(r["at"]))} 判定流失（${CONF[String(r["confidence"])] ?? String(r["confidence"])}）`));
  const weeks = await weekly(db, 8, c.now);
  const chart: AskChart = c.by && ranked.length
    ? { type: "bar", labels: ranked.slice(0, 8).map((x) => x.label), series: [{ label: "流失率 %", data: ranked.slice(0, 8).map((x) => Math.round(num(x.rate) * 100)), tone: "warn" }] }
    : { type: "bar", labels: weeks.map((w) => w.week_end), series: [{ label: "報價", data: weeks.map((w) => w.priced) }, { label: "價格後流失", data: weeks.map((w) => w.dropoff), style: "line", tone: "warn" }] };
  const conclusion = `最近 ${c.days} 天報價 ${pd.base} 次，${pd.count} 位在報價後沒有再回覆（${P(pd.rate)}，前期 ${P(pd.prev_rate)}）${worst ? `；${worst.label} 最高（${P(worst.rate)}，n=${worst.priced}）` : "；樣本還不足以指出單一原因"}。`;
  return { conclusion, numbers, reasons, leads, evidence, chart,
    actions: [{ text: "把報價後兩天沒回的客戶列成每日清單，當天由主管指派回訪。", owner_role: "manager" }, { text: "報價時一起給下一步（可看車的時段），不要只丟數字。", owner_role: "staff" }],
    how: [periodLine(a), "報價次數＝期間內「報價」事件數（不含 不確定）", "報價後未再回覆＝報價後客戶沒有再回覆、也沒有預約或議價，由漏斗規則判定；只計「確定」與「強烈建議」", "流失率＝未再回覆數 ÷ 報價次數；分項依客戶所屬業務／車款／車型分組，報價少於 3 次的分項不拿來下結論", "圖表：每週報價次數與價格後流失數（依事件時間分週）"] };
}

async function staffB(c: Ctx): Promise<Built> {
  const { a } = c; const rows = a.staff;
  const one = c.staffName ? rows.find((s) => s.name === c.staffName) ?? null : null;
  const byGp = rows.slice().sort((x, y) => y.gross_profit - x.gross_profit);
  const byDrop = rows.filter((s) => s.priced >= 3).map((s) => ({ ...s, rate: s.dropped / s.priced })).sort((x, y) => y.rate - x.rate);
  const bySlow = rows.filter((s) => s.median_first_response_min != null).sort((x, y) => num(y.median_first_response_min) - num(x.median_first_response_min));
  const top = byGp[0], drop = byDrop[0], slow = bySlow[0], fast = bySlow[bySlow.length - 1];
  const numbers: AskNumber[] = one ? [
      { label: "進線", value: `${one.leads} 位`, href: staffHref(one.name) }, { label: "報價", value: `${one.priced} 次` },
      { label: "報價後流失", value: `${one.dropped} 位（${P(one.priced ? one.dropped / one.priced : null)}）`, href: `/conversations?flag=price_dropoff&staff=${enc(one.name)}` },
      { label: "預約", value: `${one.booked} 次` }, { label: "成交", value: `${one.sold} 台` }, { label: "毛利", value: W(one.gross_profit) },
      { label: "首次回覆中位數", value: one.median_first_response_min == null ? "—" : `${one.median_first_response_min} 分鐘` }, { label: "跟進", value: `${one.followups} 次` },
    ] : [
      ...(top ? [{ label: "毛利最高", value: `${top.name} ${W(top.gross_profit)}`, sub: `${top.sold} 台`, href: staffHref(top.name) }] : []),
      ...(drop ? [{ label: "報價後流失率最高", value: `${drop.name} ${P(drop.rate)}`, sub: `n=${drop.priced}`, href: `/conversations?flag=price_dropoff&staff=${enc(drop.name)}` }] : []),
      ...(slow ? [{ label: "首次回覆最慢", value: `${slow.name} ${slow.median_first_response_min} 分鐘`, href: staffHref(slow.name) }] : []),
      { label: "業務人數", value: `${rows.length} 位`, href: "/funnel" },
    ];
  const reasons: Built["reasons"] = [];
  if (!one && slow && fast && slow !== fast) reasons.push({ text: `首次回覆速度差很多：最快 ${fast.name} ${fast.median_first_response_min} 分鐘，最慢 ${slow.name} ${slow.median_first_response_min} 分鐘。`, claim: "fact" });
  if (one && drop && one.name === drop.name) reasons.push({ text: `${one.name} 的報價後流失率是全公司最高（${P(drop.rate)}，n=${drop.priced}）。`, claim: "fact" });
  const evidence = pick(c.insights, /staff|followup|業務|跟進|回覆/i);
  reasons.push(...hypos(c.insights, evidence.map((e) => e.id)));
  const att = one ? a.attention.filter((x) => x.staff === one.name) : a.attention;
  const leads = att.slice(0, 8).map((x) => ({ id: x.lead_id, contact: x.contact, staff: x.staff, vehicle: x.vehicle, note: `${KIND[x.kind] ?? x.kind}：${x.reason}` }));
  const shown = byGp.slice(0, 8);
  const chart: AskChart = { type: "bar", labels: shown.map((s) => s.name), series: [{ label: "毛利（萬）", data: shown.map((s) => Math.round(s.gross_profit / 10000)) }, { label: "成交台數", data: shown.map((s) => s.sold), tone: "accent" }] };
  const conclusion = one
    ? `${one.name}：進線 ${one.leads} 位、報價 ${one.priced} 次、報價後流失 ${one.dropped} 位、預約 ${one.booked} 次、成交 ${one.sold} 台、毛利 ${W(one.gross_profit)}${one.median_first_response_min != null ? `，首次回覆中位數 ${one.median_first_response_min} 分鐘` : ""}。`
    : [top ? `毛利最高是 ${top.name}（${W(top.gross_profit)}、${top.sold} 台）` : "", drop ? `報價後流失率最高是 ${drop.name}（${P(drop.rate)}，n=${drop.priced}）` : "", slow ? `首次回覆最慢是 ${slow.name}（${slow.median_first_response_min} 分鐘）` : ""].filter(Boolean).join("；") + "。";
  return { conclusion, numbers, reasons, leads, evidence, chart,
    actions: [{ text: "把首次回覆最慢與流失率最高的業務，各抽三段對話一起看，分清是話術問題還是分配問題。", owner_role: "manager" }],
    how: ["業務數字是累計、不分期間：進線＝指派給他的客戶數；報價／流失／預約＝他客戶的事件數；成交與毛利來自成交帳本", "首次回覆中位數＝客戶每則訊息到業務下一則回覆的間隔，取中位數（分鐘）", "報價少於 3 次的業務不列入流失率排名", "受影響客戶＝需要注意清單裡屬於該業務的客戶"] };
}

async function vehicleB(c: Ctx): Promise<Built> {
  const { a, db } = c; const rows = a.vehicles;
  const one = c.vehName ? rows.find((v) => v.name === c.vehName) ?? null : null;
  const byInq = rows.slice().sort((x, y) => y.inquiries - x.inquiries);
  const byConv = rows.filter((v) => v.inquiries >= 3).sort((x, y) => num(y.inquiry_to_sold) - num(x.inquiry_to_sold));
  const byDrop = rows.filter((v) => v.priced >= 3).map((v) => ({ ...v, rate: v.dropped / v.priced })).sort((x, y) => y.rate - x.rate);
  const hot = byInq[0], best = byConv[0], worst = byConv[byConv.length - 1], drop = byDrop[0];
  const numbers: AskNumber[] = one ? [
      { label: "詢問", value: `${one.inquiries} 位`, href: vehHref(one.name) }, { label: "報價", value: `${one.priced} 次` },
      { label: "報價後流失", value: `${one.dropped} 位（${P(one.priced ? one.dropped / one.priced : null)}）`, href: `/conversations?flag=price_dropoff&vehicle=${enc(one.name)}` },
      { label: "預約", value: `${one.booked} 次` }, { label: "成交", value: `${one.sold} 台`, sub: `詢問→成交 ${P(one.inquiry_to_sold)}` }, { label: "毛利", value: W(one.gross_profit) },
    ] : [
      ...(hot ? [{ label: "詢問最多", value: `${hot.name} ${hot.inquiries} 位`, sub: `成交 ${hot.sold} 台`, href: vehHref(hot.name) }] : []),
      ...(best ? [{ label: "詢問→成交最高", value: `${best.name} ${P(best.inquiry_to_sold)}`, sub: `n=${best.inquiries}`, href: vehHref(best.name) }] : []),
      ...(worst && worst !== best ? [{ label: "詢問→成交最低", value: `${worst.name} ${P(worst.inquiry_to_sold)}`, sub: `n=${worst.inquiries}`, href: vehHref(worst.name) }] : []),
      ...(drop ? [{ label: "報價後流失率最高", value: `${drop.name} ${P(drop.rate)}`, sub: `n=${drop.priced}`, href: `/conversations?flag=price_dropoff&vehicle=${enc(drop.name)}` }] : []),
    ];
  const reasons: Built["reasons"] = [];
  if (!one && hot && worst && hot.name === worst.name) reasons.push({ text: `${hot.name} 詢問最多但詢問→成交最低（${P(hot.inquiry_to_sold)}），是問的人多、買的人少的車。`, claim: "fact" });
  const evidence = pick(c.insights, /vehicle|opportunity|車款/i);
  reasons.push(...hypos(c.insights, evidence.map((e) => e.id)));
  const target = one?.name ?? hot?.name ?? null;
  const rows2 = target ? await db.all(`${LEAD} WHERE (v.brand||' '||v.model) = ? AND l.outcome = '' ORDER BY l.opened_at DESC LIMIT 8`, target) : [];
  const leads = rows2.map((r) => lead(r, `${target} 進行中`));
  const shown = byInq.slice(0, 8);
  const chart: AskChart = { type: "bar", labels: shown.map((v) => v.name), series: [{ label: "詢問", data: shown.map((v) => v.inquiries) }, { label: "成交", data: shown.map((v) => v.sold), tone: "accent" }] };
  const conclusion = one
    ? `${one.name}：詢問 ${one.inquiries} 位、報價 ${one.priced} 次、報價後流失 ${one.dropped} 位、預約 ${one.booked} 次、成交 ${one.sold} 台（詢問→成交 ${P(one.inquiry_to_sold)}），毛利 ${W(one.gross_profit)}。`
    : [hot ? `詢問最多是 ${hot.name}（${hot.inquiries} 位、成交 ${hot.sold} 台）` : "", best ? `詢問→成交最高是 ${best.name}（${P(best.inquiry_to_sold)}）` : "", drop ? `報價後最容易流失的是 ${drop.name}（${P(drop.rate)}，n=${drop.priced}）` : ""].filter(Boolean).join("；") + "。";
  return { conclusion, numbers, reasons, leads, evidence, chart,
    actions: [{ text: "問的人多但不成交的車，先查售價相對行情，再查報價話術；兩者都沒問題才是車況。", owner_role: "manager" }],
    how: ["車款數字是累計、不分期間：詢問＝對這台車開過的客戶數；報價／流失／預約＝這些客戶的事件數；成交與毛利來自成交帳本", "詢問→成交＝成交數 ÷ 詢問數；詢問少於 3 位的車不列入排名", "受影響客戶＝該車款仍在進行中的客戶（未成交、未流失）"] };
}

async function appointmentsB(c: Ctx): Promise<Built> {
  const { a, db } = c; const ap = a.appointments, v = a.visits, bv = a.conversion["booking_to_visit"], vs = a.conversion["visit_to_sold"];
  const overdue = await db.all(`SELECT x.*, ap.scheduled_for FROM (${LEAD}) x JOIN appointments ap ON ap.lead_id = x.id AND ap.status = 'booked' AND ap.scheduled_for < ?
    WHERE NOT EXISTS (SELECT 1 FROM visits vi WHERE vi.lead_id = x.id) ORDER BY ap.scheduled_for DESC LIMIT 8`, c.now);
  const numbers: AskNumber[] = [
    { label: "提議看車", value: `${num(ap["proposed"])} 次` },
    { label: "預約成立", value: `${num(ap["booked"])} 次`, sub: `前期 ${num(ap["prev_booked"])}`, href: "/appointments" },
    { label: "到店", value: `${num(v["count"])} 位`, sub: `前期 ${num(v["prev_count"])}`, href: "/conversations?event=STORE_VISIT" },
    { label: "爽約", value: `${num(ap["no_show"])} 位`, sub: `爽約率 ${P(ap["no_show_rate"])}` },
    { label: "預約→到店", value: P(bv?.rate), sub: `n=${bv?.n ?? 0}`, href: "/funnel" }, { label: "到店→成交", value: P(vs?.rate), sub: `n=${vs?.n ?? 0}`, href: "/funnel" },
    { label: "預約已過未到店", value: `${overdue.length} 位`, href: "/attention?kind=booked_but_no_visit" },
  ];
  const reasons: Built["reasons"] = [];
  if (bv && bv.rate != null && bv.prev_rate != null && bv.n >= 5) reasons.push({ text: `預約→到店 ${P(bv.rate)}，前期 ${P(bv.prev_rate)}（n=${bv.n}／${bv.prev_n}）。`, claim: "fact" });
  const evidence = pick(c.insights, /appointment|預約|到店|爽約/i);
  reasons.push(...hypos(c.insights, evidence.map((e) => e.id)));
  const leads = overdue.map((r) => lead(r, `${md(String(r["scheduled_for"]))} 預約已過，沒有到店紀錄`));
  const weeks = await weekly(db, 8, c.now);
  const chart: AskChart = { type: "bar", labels: weeks.map((w) => w.week_end), series: [{ label: "預約成立", data: weeks.map((w) => w.booked) }, { label: "到店", data: weeks.map((w) => w.visits), tone: "accent" }] };
  const conclusion = `最近 ${c.days} 天預約成立 ${num(ap["booked"])} 次（提議 ${num(ap["proposed"])}）、到店 ${num(v["count"])} 位、爽約 ${num(ap["no_show"])} 位（${P(ap["no_show_rate"])}）；預約→到店 ${P(bv?.rate)}（n=${bv?.n ?? 0}）。${overdue.length ? `目前有 ${overdue.length} 位預約時間已過但沒有到店紀錄。` : ""}`;
  return { conclusion, numbers, reasons, leads, evidence, chart,
    actions: [{ text: "預約前一天由業務用 LINE 再確認一次，沒回覆的當天早上打電話。", owner_role: "staff" }, { text: "預約已過沒到店的客戶，兩天內由主管檢查是否重新約了。", owner_role: "manager" }],
    how: [periodLine(a), "提議看車／預約成立／爽約＝期間內對應事件數（預約帳本優先，沒有帳本時由對話文字判定）", "預約→到店＝期間內有預約成立的客戶中，之後有到店紀錄的比例；到店→成交同理（以客戶計）", "預約已過未到店＝預約狀態仍是成立、時間已過、沒有到店紀錄（不分期間）"] };
}

async function dealsB(c: Ctx): Promise<Built> {
  const { a, db } = c; const d = a.deals; const top = d.by_staff[0];
  const rows = await db.all(`SELECT x.*, de.sale_price, de.gross_profit, de.closed_at FROM (${LEAD}) x JOIN deals de ON de.lead_id = x.id AND de.status = 'sold' AND de.closed_at >= ? AND de.closed_at < ? ORDER BY de.gross_profit ASC LIMIT 8`, a.period.from, a.period.to);
  const numbers: AskNumber[] = [
    { label: "成交", value: `${d.sold} 台`, sub: `前期 ${d.prev_sold}`, href: "/deals" },
    { label: "營收", value: W(d.revenue), sub: `前期 ${W(d.prev_revenue)}`, href: "/deals" },
    { label: "毛利", value: W(d.gross_profit), sub: `毛利率 ${P(d.gp_margin)} · 前期 ${W(d.prev_gross_profit)}`, href: "/deals" },
    { label: "平均毛利", value: d.avg_gp == null ? "—" : W(d.avg_gp) },
    { label: "低於成本", value: `${d.below_cost} 筆`, href: "/deals" },
    { label: "流失", value: `${d.lost} 台`, href: "/conversations?outcome=lost" },
    ...(top ? [{ label: "毛利最高業務", value: `${top.staff} ${W(top.gross_profit)}`, sub: `${top.sold} 台`, href: staffHref(top.staff) }] : []),
  ];
  const reasons: Built["reasons"] = [];
  if (d.below_cost) reasons.push({ text: `有 ${d.below_cost} 筆成交毛利是負的（賣價低於成本）。`, claim: "fact" });
  const lr = d.lost_reasons[0]; if (lr) reasons.push({ text: `流失原因最多是「${LOST_REASON[lr.reason] ?? lr.reason}」（${lr.n} 筆）。`, claim: "fact" });
  const evidence = pick(c.insights, /anomaly|成交|毛利|成本/i);
  reasons.push(...hypos(c.insights, evidence.map((e) => e.id)));
  const leads = rows.map((r) => lead(r, `${md(String(r["closed_at"]))} 成交 · 售價 ${W(num(r["sale_price"]))} · 毛利 ${num(r["gross_profit"]) < 0 ? "負 " : ""}${W(Math.abs(num(r["gross_profit"])))}`));
  const weeks = await weekly(db, 8, c.now);
  const chart: AskChart = { type: "bar", labels: weeks.map((w) => w.week_end), series: [{ label: "成交台數", data: weeks.map((w) => w.sold) }, { label: "毛利（萬）", data: weeks.map((w) => Math.round(w.gp / 10000)), style: "line", tone: "accent" }] };
  const conclusion = `最近 ${c.days} 天成交 ${d.sold} 台（前期 ${d.prev_sold}）、營收 ${W(d.revenue)}、毛利 ${W(d.gross_profit)}（毛利率 ${P(d.gp_margin)}）${d.below_cost ? `，其中 ${d.below_cost} 筆低於成本` : ""}${top ? `；毛利最高是 ${top.staff}（${W(top.gross_profit)}）` : ""}。`;
  return { conclusion, numbers, reasons, leads, evidence, chart,
    actions: [{ text: "低於成本的每一筆，主管在週會說明原因（讓價換成交、還是車況問題）。", owner_role: "manager" }],
    how: [periodLine(a), "成交＝成交帳本狀態為 sold、結案日在期間內；營收＝售價加總；毛利＝售價－成本；毛利率＝毛利 ÷ 營收", "低於成本＝毛利小於 0 的筆數；流失原因來自帳本欄位，沒填的不算", "受影響客戶＝本期成交，毛利由低到高排（最需要看的在前面）"] };
}

async function attentionB(c: Ctx): Promise<Built> {
  const { a } = c; const att = a.attention;
  const counts: Record<string, number> = {}; for (const x of att) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
  const numbers: AskNumber[] = Object.keys(KIND).map((k) => ({ label: KIND[k] ?? k, value: `${counts[k] ?? 0} 位`, href: `/attention?kind=${k}` }));
  const oldest = att.filter((x) => x.since).slice().sort((x, y) => Date.parse(x.since) - Date.parse(y.since))[0];
  const reasons: Built["reasons"] = [];
  if (oldest) reasons.push({ text: `等最久的是 ${oldest.contact}（${KIND[oldest.kind] ?? oldest.kind}，已等 ${hrs(oldest.since, c.now)} 小時）。`, claim: "fact" });
  const evidence = c.insights.slice(0, 3).map((i) => ({ id: num(i["id"]), title: String(i["title"]), severity: String(i["severity"]) }));
  const leads = att.slice(0, 8).map((x) => ({ id: x.lead_id, contact: x.contact, staff: x.staff, vehicle: x.vehicle, note: `${KIND[x.kind] ?? x.kind}：${x.reason}` }));
  const urgent = counts["high_intent_no_followup"] ?? 0;
  const conclusion = att.length
    ? `今天要處理 ${att.length} 位：${Object.keys(KIND).filter((k) => counts[k]).map((k) => `${KIND[k]} ${counts[k]}`).join("、")}。${urgent ? `先回 ${urgent} 位急迫的` : "先回報價後沒人跟的"}${oldest ? `，${oldest.contact} 等最久。` : "。"}`
    : "目前沒有需要注意的客戶。";
  return { conclusion, numbers, reasons, leads, evidence, chart: null,
    actions: [{ text: "把急迫未跟進的客戶今天分回給業務，下班前回報。", owner_role: "manager" }, { text: "報價後沒回的客戶，用「看車時段」而不是「再考慮嗎」去敲。", owner_role: "staff" }],
    how: ["急迫未跟進＝客戶說過急（今天／明天要看車等）之後沒有任何業務跟進，且客戶最後一則訊息已超過 1 天", "報價後未跟進＝兩週內判定價格後流失（確定／強烈建議），之後沒有業務跟進", "預約已過未到店＝預約仍是成立、時間已過、沒有到店紀錄", "貸款未回覆＝兩週內客戶問了貸款，業務沒有給具體答案", "四條規則只看仍在進行中的客戶（未成交、未流失）；清單每次開頁重算"] };
}

async function overviewB(c: Ctx): Promise<Built> {
  const { a } = c; const f = a.funnel, d = a.deals, pd = a.price_dropoff;
  const worst = Object.entries(a.conversion).filter(([k, v]) => k in PAIR && v.n >= 8 && v.rate != null).sort((x, y) => num(x[1].rate) - num(y[1].rate))[0];
  const numbers: AskNumber[] = [
    { label: "新進線", value: `${f.leads} 位`, sub: `前期 ${f.prev_leads}`, href: "/conversations" },
    { label: "報價", value: `${pd.base} 次`, sub: `價格後流失 ${P(pd.rate)}`, href: "/funnel" },
    { label: "預約成立", value: `${num(a.appointments["booked"])} 次`, href: "/appointments" },
    { label: "到店", value: `${num(a.visits["count"])} 位`, href: "/appointments" },
    { label: "成交", value: `${d.sold} 台`, sub: `前期 ${d.prev_sold}`, href: "/deals" },
    { label: "毛利", value: W(d.gross_profit), sub: `毛利率 ${P(d.gp_margin)}`, href: "/deals" },
    { label: "需要注意", value: `${a.attention.length} 位`, href: "/attention" },
  ];
  const reasons: Built["reasons"] = [];
  if (worst) reasons.push({ text: `漏斗最弱的一段是 ${PAIR[worst[0]] ?? worst[0]}：${P(worst[1].rate)}（n=${worst[1].n}，前期 ${P(worst[1].prev_rate)}）。`, claim: "fact" });
  const evidence = c.insights.slice(0, 3).map((i) => ({ id: num(i["id"]), title: String(i["title"]), severity: String(i["severity"]) }));
  reasons.push(...hypos(c.insights, evidence.map((e) => e.id)).slice(0, 2));
  const leads = a.attention.slice(0, 5).map((x) => ({ id: x.lead_id, contact: x.contact, staff: x.staff, vehicle: x.vehicle, note: `${KIND[x.kind] ?? x.kind}：${x.reason}` }));
  const conclusion = `最近 ${c.days} 天新進線 ${f.leads} 位、報價 ${pd.base} 次、預約 ${num(a.appointments["booked"])} 次、到店 ${num(a.visits["count"])} 位、成交 ${d.sold} 台、毛利 ${W(d.gross_profit)}${worst ? `；最弱的一段是 ${PAIR[worst[0]] ?? worst[0]}（${P(worst[1].rate)}）` : ""}；需要注意 ${a.attention.length} 位。`;
  const first = evidence[0];
  return { conclusion, numbers, reasons, leads, evidence, chart: null,
    actions: first ? [{ text: `先看 #${first.id}「${first.title}」的證據，再決定要不要動人或動價。`, owner_role: "ceo" }] : [{ text: "看一遍需要注意清單。", owner_role: "ceo" }],
    how: [periodLine(a), "新進線＝期間內開始的客戶；報價／預約／到店＝期間內事件數（不含 不確定）；成交與毛利來自成交帳本", "轉換率以客戶計：到過 A 階段的客戶中之後到 B 的比例；樣本少於 8 不拿來判斷最弱的一段", "需要注意＝四條規則現算（急迫未跟進、報價後未跟進、預約已過未到店、貸款未回覆）"] };
}

/* ── 員工效能／教練／流失原因／決策 ── */
const fmtFeat = (key: string, v: number | null) => { const u = FEATURE_LABEL[key]?.unit ?? "rate"; return v == null ? "—" : u === "rate" || u === "pct" ? pctS(v) : u === "min" ? `${Math.round(v)} 分鐘` : String(Math.round(v * 10) / 10); };
const mtxt = (m: Metric) => (m.ok ? `${pctS(m.rate)}（${m.k}/${m.n}）` : `資料不足（${m.k}/${m.n}）`);
async function report(c: Ctx): Promise<StaffReport> { return computeStaffReport(c.db, { days: Math.max(30, c.days), to: c.now }); }

async function staffCompareB(c: Ctx): Promise<Built> {
  const r = await report(c);
  const named = c.staffNames.map((n) => r.staff.find((s) => s.name === n)).filter((s): s is StaffMetrics => !!s);
  const FEATS = ["first_response_min", "followup_24h_rate", "asked_after_price", "objection_clarified", "proposed_after_intent", "fin_answered", "postvisit_24h", "budget_clarified"];
  const how = [`期間：最近 ${r.period.days} 天（${md(r.period.from)}～${md(r.period.to)}）`, "成交率＝成交 ÷ 已結案（本期進線的客戶）；比例都附樣本，低於門檻標「資料不足」", "行為特徵只在情境出現時才算（例如客戶說太貴才有「異議後先釐清」）", "這些是觀察到的關聯，不是因果：表現好的人客戶量、車價帶、運氣都可能不同"];
  if (named.length >= 2) {
    const [A, B] = [named[0]!, named[1]!];
    const numbers: AskNumber[] = [
      { label: `${A.name} 成交率`, value: mtxt(A.funnel.close), sub: `毛利 ${wanS(A.commercial.gp)}`, href: `/staff/${A.id}` }, { label: `${B.name} 成交率`, value: mtxt(B.funnel.close), sub: `毛利 ${wanS(B.commercial.gp)}`, href: `/staff/${B.id}` },
      { label: `${A.name} 報價後續走`, value: mtxt(A.funnel.price_continue) }, { label: `${B.name} 報價後續走`, value: mtxt(B.funnel.price_continue) },
      { label: `${A.name} 首次回覆`, value: A.activity.first_response.ok ? `${Math.round(A.activity.first_response.value!)} 分鐘` : "資料不足" }, { label: `${B.name} 首次回覆`, value: B.activity.first_response.ok ? `${Math.round(B.activity.first_response.value!)} 分鐘` : "資料不足" },
    ];
    const reasons: Built["reasons"] = [];
    const labels: string[] = [], da: number[] = [], dbv: number[] = [];
    for (const k of FEATS) {
      const a = A.behaviors[k], b = B.behaviors[k]; if (!a || !b || !a.ok || !b.ok) continue;
      const av = "rate" in a ? a.rate : a.value, bv = "rate" in b ? b.rate : b.value; if (av == null || bv == null) continue;
      const meta = FEATURE_LABEL[k]!; const diff = meta.unit === "min" ? Math.max(av, bv) / Math.max(1, Math.min(av, bv)) >= 1.8 : Math.abs(av - bv) >= 0.15;
      if (diff) reasons.push({ text: `「${meta.label}」：${A.name} ${fmtFeat(k, av)}（n=${a.n}），${B.name} ${fmtFeat(k, bv)}（n=${b.n}）`, claim: "fact" });
      if (meta.unit !== "min") { labels.push(meta.label); da.push(Math.round(av * 100)); dbv.push(Math.round(bv * 100)); }
    }
    if (!reasons.length) reasons.push({ text: "兩人在可比較的行為上差異不大（或樣本不足）；成果差異可能來自客戶量、車價帶或運氣。", claim: "fact" });
    const weaker = (A.funnel.close.low <= B.funnel.close.low ? A : B);
    const lossRows = await c.db.all(`SELECT la.lead_id, la.primary_reason, COALESCE(NULLIF(ct.pseudonym,''), ct.display_name) AS contact, COALESCE(v.brand||' '||v.model,'') AS vehicle FROM loss_analyses la JOIN leads l ON l.id = la.lead_id JOIN contacts ct ON ct.id = l.contact_id LEFT JOIN vehicles v ON v.id = l.vehicle_id WHERE l.staff_id = ? AND la.status = 'lost' AND l.opened_at >= ? ORDER BY la.closed_at DESC LIMIT 6`, weaker.id, r.period.from);
    const leads = lossRows.map((x) => ({ id: num(x["lead_id"]), contact: String(x["contact"]), staff: weaker.name, vehicle: String(x["vehicle"]), note: `流失：${(LOSS_LABEL as Record<string, string>)[String(x["primary_reason"])] ?? x["primary_reason"]}` }));
    const chart: AskChart | null = labels.length ? { type: "bar", labels, series: [{ label: `${A.name} %`, data: da }, { label: `${B.name} %`, data: dbv, tone: "accent" }] } : null;
    return { conclusion: `${A.name} 成交率 ${mtxt(A.funnel.close)}、${B.name} ${mtxt(B.funnel.close)}；毛利 ${wanS(A.commercial.gp)} vs ${wanS(B.commercial.gp)}。${reasons[0]?.claim === "fact" && reasons.length > 1 ? `行為上最明顯的差別：${reasons.slice(0, 2).map((x) => x.text).join("；")}。` : ""}`, numbers, reasons, leads, evidence: [], chart, how,
      actions: (r.issues[weaker.id] ?? []).slice(0, 2).map((i) => ({ text: `${weaker.name}：${i.coaching}`, owner_role: "manager" })) };
  }
  // 沒點名：表現最佳組 vs 需關注組
  const top = r.top.map((t) => t.name).join("、") || "（沒有人達到門檻）", watch = r.watch.map((w) => w.name).join("、") || "（沒有人）";
  const numbers: AskNumber[] = r.compare.funnel.map((f) => ({ label: f.label, value: `${pctS(f.top.rate)} vs ${pctS(f.watch.rate)}`, sub: `團隊 ${pctS(f.team.rate)} · n=${f.top.n}/${f.watch.n}`, href: "/staff" }));
  const reasons: Built["reasons"] = r.compare.observations.slice(0, 6).map((o) => ({ text: o.text, claim: "fact" as const }));
  const obs = r.compare.observations.filter((o) => FEATURE_LABEL[o.feature]?.unit === "rate").slice(0, 6);
  const chart: AskChart | null = obs.length ? { type: "bar", labels: obs.map((o) => o.label), series: [{ label: "表現最佳組 %", data: obs.map((o) => Math.round((o.top ?? 0) * 100)) }, { label: "需關注組 %", data: obs.map((o) => Math.round((o.watch ?? 0) * 100)), tone: "warn" }] } : null;
  const leads = r.watch.flatMap((w) => w.evidence.lead_ids.slice(0, 3).map((id) => ({ id, contact: "", staff: w.name, vehicle: "", note: w.issue.text })));
  const pats = r.patterns.filter((p) => p.outcome && p.outcome.lift != null && p.outcome.lift >= 0.15 && p.staff.length).slice(0, 3);
  return { conclusion: `表現最佳：${top}；需關注：${watch}。${r.compare.summary}`, numbers, reasons, leads, evidence: [], chart, how,
    actions: pats.length ? pats.map((p) => ({ text: `把「${p.label}」教給全隊（${p.staff.map((s) => s.name).join("、")}示範；有做到的客戶成交率 ${pctS(p.outcome!.with.rate)} vs 沒做到 ${pctS(p.outcome!.without.rate)}，關聯）`, owner_role: "manager" })) : [{ text: "先把需關注組的教練計畫看一遍，再決定要教什麼。", owner_role: "manager" }],
    extras: [{ title: "成功模式庫（有示範者的）", lines: r.patterns.filter((p) => p.staff.length).map((p) => `${p.label}：${p.staff.map((s) => s.name).join("、")}（n=${p.n_total}，${p.confidence === "STRONGLY_SUGGESTED" ? "強烈建議" : p.confidence === "POSSIBLE" ? "可能" : "樣本不足"}）`), href: "/staff#patterns" }] };
}

async function coachingB(c: Ctx): Promise<Built> {
  const r = await report(c);
  const name = c.staffNames[0]; const s = name ? r.staff.find((x) => x.name === name) : null;
  if (!s) {
    const pats = r.patterns.filter((p) => p.staff.length && p.outcome && p.outcome.lift != null && p.outcome.lift >= 0.1).sort((a, b) => (b.outcome!.lift ?? 0) - (a.outcome!.lift ?? 0));
    return { conclusion: pats.length ? `最值得教全隊的是「${pats[0]!.label}」：${pats[0]!.staff.map((x) => x.name).join("、")}做得到；有做到的客戶成交率 ${pctS(pats[0]!.outcome!.with.rate)}（n=${pats[0]!.outcome!.with.n}），沒做到 ${pctS(pats[0]!.outcome!.without.rate)}（n=${pats[0]!.outcome!.without.n}）—— 這是關聯。要看個人的教練計畫請點名（例如「阿凱該怎麼改進」）。` : "目前還沒有樣本足夠、又跟成交有關聯的成功模式；先累積資料。",
      numbers: pats.slice(0, 4).map((p) => ({ label: p.label, value: `${pctS(p.outcome!.with.rate)} vs ${pctS(p.outcome!.without.rate)}`, sub: `n=${p.outcome!.with.n}/${p.outcome!.without.n}`, href: "/staff#patterns" })),
      reasons: pats.slice(0, 3).map((p) => ({ text: `${p.label}：${p.what}（示範者 ${p.staff.map((x) => x.name).join("、")}）`, claim: "correlation" as const })), leads: [], evidence: [], chart: null,
      actions: pats.slice(0, 2).map((p) => ({ text: `請 ${p.staff[0]!.name} 錄 3 分鐘說明＋兩則範例訊息，放進新人教材：${p.label}`, owner_role: "manager" })),
      how: ["成功模式＝行為特徵達門檻的員工；關聯＝全團隊有做到 vs 沒做到的客戶成交率差", "樣本不足的模式不列"] };
  }
  const plan = await buildCoachingPlan(c.db, r, s.id, c.now);
  if (!plan) return { conclusion: "找不到教練計畫。", numbers: [], reasons: [], leads: [], evidence: [], chart: null, actions: [], how: [] };
  const numbers: AskNumber[] = [{ label: "成交率", value: mtxt(s.funnel.close), href: `/staff/${s.id}` }, { label: "報價後續走", value: mtxt(s.funnel.price_continue) }, { label: "預約轉換", value: mtxt(s.funnel.appt) }, { label: "沉默後跟進", value: mtxt(s.activity.followup_24h) }, { label: "首次回覆", value: s.activity.first_response.ok ? `${Math.round(s.activity.first_response.value!)} 分鐘` : "資料不足", sub: `團隊 ${r.team.activity.first_response.value == null ? "—" : Math.round(r.team.activity.first_response.value)} 分鐘` }];
  const reasons: Built["reasons"] = [];
  if (plan.main_issue) reasons.push({ text: `主要問題：${plan.main_issue.text}（影響 ${plan.main_issue.affected} 位客戶）`, claim: "fact" });
  for (const x of plan.compared.filter((y) => y.worse).slice(0, 4)) reasons.push({ text: `「${x.label}」你 ${fmtFeat(x.feature, x.mine)}（n=${x.n}），${plan.peers_label} ${fmtFeat(x.feature, x.peers)}，團隊 ${fmtFeat(x.feature, x.team)}`, claim: "fact" });
  const leads = plan.evidence.conversations.map((x) => ({ id: x.lead_id, contact: x.contact, staff: s.name, vehicle: "", note: `${x.reason}${x.driver === "process" ? "（流程面）" : ""}` }));
  return { conclusion: plan.main_issue ? `${s.name} 最該改的是：${plan.changes[0]?.text ?? plan.main_issue.coaching}` : `${s.name} 目前沒有明顯落後的行為；${plan.strengths.length ? `強項：${plan.strengths.slice(0, 2).join("、")}` : "先維持"}。`,
    numbers, reasons, leads, evidence: [], chart: null,
    actions: plan.changes.slice(0, 4).map((ch) => ({ text: `${ch.text}（${ch.why}；${ch.confidence === "STRONGLY_SUGGESTED" ? "強烈建議" : ch.confidence === "POSSIBLE" ? "可能" : "樣本不足"}）`, owner_role: "staff" })),
    how: ["教練計畫＝本人指標 vs 表現最佳組 vs 團隊，只在情境相同時比較；每條建議附樣本與關聯", "訊息範例來自本人真實訊息，改寫版是教練建議，系統不會代發", ...plan.insufficient.slice(0, 3).map((x) => `資料不足：${x}`)],
    extras: plan.message_examples.map((e) => ({ title: `訊息改寫範例（${{ price: "報價", financing: "貸款", objection: "價格異議", postvisit: "到店後" }[e.kind] ?? e.kind}）· ${e.contact}`, lines: [`目前：${e.current}`, `問題：${e.issue}`, `強者做法：${e.stronger}`, `建議版：${e.suggested}`, e.note], href: `/conversations/${e.lead_id}#m${e.message_id}` })) };
}

async function lossReasonsB(c: Ctx): Promise<Built> {
  const agg = await lossAggregate(c.db, { days: c.days, to: c.now });
  const rising = /增加|上升|變多/.test(c.q);
  const reasons = (rising ? [...agg.reasons].sort((a, b) => b.delta - a.delta) : agg.reasons).filter((x) => x.k > 0);
  const filterReason = c.q.match(/貸款|價格|爽約|車況|折抵|家人|時機|別家|回覆太慢|跟進/);
  const wanted = filterReason ? ({ 貸款: "financing", 價格: "price_resistance", 爽約: "no_show", 車況: "vehicle_condition", 折抵: "trade_in", 家人: "family", 時機: "timing", 別家: "bought_elsewhere", 回覆太慢: "slow_response", 跟進: "weak_followup" } as Record<string, string>)[filterReason[0]] : null;
  let list = agg.list; if (wanted) list = list.filter((x) => x.reason === wanted || x.secondary === wanted);
  if (c.vehName) list = list.filter((x) => x.vehicle === c.vehName);
  const numbers: AskNumber[] = [{ label: "未成交", value: `${agg.totals.lost} 位`, sub: `前期 ${agg.totals.prev}`, href: "/loss" }, { label: "流程面", value: `${agg.driver.process} 位`, sub: "回覆太慢／跟進不足", href: "/loss?driver=process" }, ...reasons.slice(0, 5).map((x) => ({ label: x.label, value: `${x.k} 位`, sub: `前期 ${x.prev_k}${x.delta > 0 ? ` ↑${x.delta}` : x.delta < 0 ? ` ↓${-x.delta}` : ""}`, href: `/loss?reason=${x.key}` }))];
  const facts: Built["reasons"] = [];
  const top = reasons[0]; if (top) facts.push({ text: `最多的是「${top.label}」${top.k} 位（${pctS(top.rate)}），前期 ${top.prev_k}。`, claim: "fact" });
  const up = agg.reasons.filter((x) => x.delta >= 2).sort((a, b) => b.delta - a.delta)[0]; if (up) facts.push({ text: `增加最多的是「${up.label}」：${up.prev_k} → ${up.k}。`, claim: "fact" });
  if (agg.driver.process) facts.push({ text: `${agg.driver.process} 位的主因是流程面（回覆太慢、跟進不足）——這部分公司可以直接改。`, claim: "fact" });
  const st = agg.by["staff"]?.[0]; if (st) facts.push({ text: `流失最多的業務是 ${st.label}（${st.n} 位，最常見 ${st.top[0]?.label ?? "—"}）。`, claim: "fact" });
  if (c.vehName) { const g = agg.by["vehicle"]?.find((x) => x.label === c.vehName); facts.push({ text: g ? `${c.vehName} 本期流失 ${g.n} 位，最常見 ${g.top.map((t) => `${t.label} ${t.k}`).join("、")}。` : `${c.vehName} 本期沒有流失紀錄。`, claim: "fact" }); }
  const leads = list.slice(0, 8).map((x) => ({ id: x.lead_id, contact: x.contact, staff: x.staff, vehicle: x.vehicle, note: `${x.reason_label}${x.secondary_label ? `／副因 ${x.secondary_label}` : ""} · ${x.stage_label}後 · ${CONF[x.confidence] ?? x.confidence}` }));
  const shown = reasons.slice(0, 8);
  const chart: AskChart = { type: "bar", labels: shown.map((x) => x.label), series: [{ label: "本期", data: shown.map((x) => x.k) }, { label: "前期", data: shown.map((x) => x.prev_k), tone: "neutral" }] };
  return { conclusion: `最近 ${agg.period.days} 天 ${agg.totals.lost} 位未成交（前期 ${agg.totals.prev}）${top ? `，最大原因是「${top.label}」${top.k} 位` : ""}${up && up.key !== top?.key ? `；增加最多的是「${up.label}」（${up.prev_k} → ${up.k}）` : ""}${agg.driver.process ? `；${agg.driver.process} 位是流程面` : ""}。`,
    numbers, reasons: facts, leads, evidence: [], chart, actions: [
      ...(agg.driver.process ? [{ text: "流程面的流失先處理：沉默 24 小時清單、新進線 15 分鐘先回一句。", owner_role: "manager" }] : []),
      ...(top && top.key === "price_resistance" ? [{ text: "價格抗拒多：報價後接問題、異議後先釐清，再談底價授權。", owner_role: "manager" }] : []),
      ...(top && top.key === "financing" ? [{ text: "貸款問題多：指定貸款窗口，24 小時內給數字。", owner_role: "manager" }] : []),
    ].slice(0, 2),
    how: [`期間：最近 ${agg.period.days} 天，以結案日計；對照前 ${agg.period.days} 天`, "每位未成交客戶由規則讀整段對話判定主因、副因、替代可能與信心；客戶自己講的才是「確定」", "流程面＝業務回覆太慢或跟進不足；客戶面＝價格、貸款、車況、家人、時機、別家…", `另有 ${agg.totals.suspected} 位沉默 ≥21 天的推定流失，不計入總數`] };
}

async function decisionsB(c: Ctx): Promise<Built> {
  const r = await report(c); const cards = await computeDecisions(c.db, r, c.now);
  const by = { high: cards.filter((x) => x.priority === "high").length, medium: cards.filter((x) => x.priority === "medium").length, low: cards.filter((x) => x.priority === "low").length };
  return { conclusion: cards.length ? `今天有 ${cards.length} 個決定要做：${by.high} 個緊急、${by.medium} 個中等。最要緊的是「${cards[0]!.title}」。` : "目前沒有需要你決定的事，先看需要注意清單。",
    numbers: [{ label: "緊急", value: `${by.high} 個`, href: "/decisions" }, { label: "中等", value: `${by.medium} 個`, href: "/decisions" }, { label: "表現最佳", value: r.top.map((t) => t.name).join("、") || "—", href: "/staff" }, { label: "需關注", value: r.watch.map((w) => w.name).join("、") || "—", href: "/staff" }],
    reasons: cards.slice(0, 4).map((x) => ({ text: `${x.title}：${x.why}`, claim: x.claim === "correlation" ? "correlation" as const : "fact" as const })),
    leads: [], evidence: [], chart: null, actions: cards.slice(0, 4).map((x) => ({ text: `${x.action}（衡量：${x.measure}）`, owner_role: "ceo" })),
    how: ["決策卡由規則產生：報價後流失高於團隊的人數、團隊跟進率、流失原因上升、高量低毛利、急迫客戶沒人回、值得教全隊的模式", "每張卡都附影響人數與衡量方式；建立行動時會存基準指標，之後比前後"],
    extras: cards.map((x) => ({ title: `[${{ high: "緊急", medium: "中等", low: "低" }[x.priority]}] ${x.title}`, lines: [`為什麼重要：${x.why}`, `觀察到的差異：${x.observed}`, `建議：${x.action}`, `衡量：${x.measure}`], href: x.links[0]?.href })) };
}

async function coachingResultB(c: Ctx): Promise<Built> {
  const name = c.staffNames[0];
  const rows = await c.db.all(`SELECT a.*, u.name AS staff_name FROM actions a LEFT JOIN users u ON u.id = a.staff_id WHERE a.kind <> '' AND a.metric_key <> ''${name ? " AND u.name = ?" : ""} ORDER BY a.id DESC LIMIT 5`, ...(name ? [name] : []));
  if (!rows.length) return { conclusion: name ? `${name} 還沒有建立過帶指標的教練行動，所以沒有前後可以比。` : "還沒有建立過帶指標的管理行動。", numbers: [], reasons: [], leads: [], evidence: [], chart: null, actions: [{ text: "在決策卡按「建立行動」，系統會存下基準指標，30 天後自動比前後。", owner_role: "manager" }], how: ["前後對照＝行動建立前 30 天 vs 建立後到現在（至少 7 天才算數）"] };
  const numbers: AskNumber[] = []; const facts: Built["reasons"] = [];
  for (const a of rows) {
    let base: Row | null = null; try { base = JSON.parse(String(a["baseline"] || "null")); } catch { base = null; }
    const days = Math.max(7, Math.ceil((Date.parse(c.now) - Date.parse(String(a["created_at"]))) / 86_400_000));
    const r = await computeStaffReport(c.db, { days, to: c.now });
    const s = a["staff_id"] ? r.staff.find((x) => x.id === num(a["staff_id"])) : null;
    const key = String(a["metric_key"]);
    const fun = s ? s.funnel : r.team.funnel; const cur = (fun as unknown as Record<string, Metric>)[key] ?? (key === "followup_24h" ? (s ? s.activity.followup_24h : r.team.activity.followup_24h) : null);
    const before = base ? (base["value"] as number | null) : null;
    numbers.push({ label: `${String(a["staff_name"] || "團隊")} · ${String(a["title"]).slice(0, 18)}`, value: cur ? `${before == null ? "—" : pctS(before)} → ${pctS(cur.rate)}` : "—", sub: cur ? `n=${cur.n}，${days} 天` : "", href: "/decisions" });
    if (cur && before != null && cur.rate != null) facts.push({ text: `${String(a["staff_name"] || "團隊")}「${String(a["title"])}」：${pctS(before)} → ${pctS(cur.rate)}（n=${cur.n}${cur.ok ? "" : "，樣本還不足"}）`, claim: "fact" });
  }
  return { conclusion: facts.length ? facts[0]!.text : "行動建立不久，樣本還不夠比前後。", numbers, reasons: facts, leads: [], evidence: [], chart: null, actions: [], how: ["前後對照＝行動建立前 30 天（基準快照）vs 建立後到現在；樣本沒達門檻不下結論", "同一個人同一期間的其他改變（客戶量、車款）也會影響，這只是觀察"] };
}

const BUILD: Record<Intent, (c: Ctx) => Promise<Built>> = { overview: overviewB, price_dropoff: priceDropoff, staff: staffB, vehicle: vehicleB, appointments: appointmentsB, deals: dealsB, attention: attentionB, staff_compare: staffCompareB, coaching: coachingB, loss_reasons: lossReasonsB, decisions: decisionsB, coaching_result: coachingResultB };
const SUGGEST: Record<Intent, string[]> = {
  overview: ["為什麼這週報價後客戶都不回？", "今天我該先處理誰？", "哪個業務毛利最高？"],
  price_dropoff: ["哪個業務報價後流失最多？", "哪款車報價後最容易流失？", "報價後沒回的客戶誰還沒人跟進？"],
  staff: ["哪個業務報價後流失最多？", "哪個業務回覆最慢？", "哪個業務毛利最高？"],
  vehicle: ["哪台車詢問最多但最少成交？", "哪款車報價後最容易流失？", "詢問最多的車成交幾台？"],
  appointments: ["預約已過但沒到店的有誰？", "這個月爽約幾位？", "到店後沒成交的原因是什麼？"],
  deals: ["這個月哪個業務毛利最高？", "有沒有低於成本的成交？", "流失原因最多的是什麼？"],
  attention: ["急迫但沒人跟進的客戶有誰？", "報價後沒回的客戶誰還沒人跟進？", "預約已過但沒到店的有誰？"],
  staff_compare: ["我們最好的業務做了什麼不一樣？", "哪些溝通模式跟成交有關？", "哪些業務組合最常一起成交？"],
  coaching: ["每個業務這週該改什麼？", "哪個行為值得教全隊？", "給我價格異議處理比較好的例子"],
  loss_reasons: ["這週客戶為什麼沒買？", "哪些流失原因在增加？", "哪個業務報價後流失最多？"],
  decisions: ["今天我該做什麼決定？", "誰需要教練？", "這週客戶為什麼沒買？"],
  coaching_result: ["今天我該做什麼決定？", "每個業務這週該改什麼？"],
};

/* ── 3. 入口與 AI 敘事 ── */
export async function answer(db: DbLike, env: Env, q: string, opts: { to?: string } = {}): Promise<AskAnswer> {
  const days = parseDays(q);
  const a = await computeAnalytics(db, { days, to: opts.to, anchor: opts.to ? "data" : "today", data_end: opts.to ?? null });   // 跟畫面同一個基準（資料截至）
  const staffList = await db.all("SELECT name FROM users WHERE role = 'agent'");
  const vehList = await db.all("SELECT brand, model FROM vehicles");
  const lq = q.toLowerCase();
  const staffNames = staffList.map((r) => String(r["name"] ?? "")).filter((n) => n.length >= 2 && q.includes(n)).sort((a, b) => q.indexOf(a) - q.indexOf(b));
  const staffName = staffNames[0] ?? null;
  const vehName = vehList.map((r) => `${r["brand"]} ${r["model"]}`).find((n) => { const m = n.split(" ").slice(1).join(" ").toLowerCase(); return lq.includes(n.toLowerCase()) || (m.length >= 2 && lq.includes(m)); }) ?? null;
  const by: Ctx["by"] = staffName || /業務|哪個人|誰的|誰報|回覆速度|回得|跟進次數|一組|二組/.test(q) ? "staff" : vehName || /車款|哪台車|哪款|哪一台|熱門|詢問度|車型|休旅|轎車/.test(q) ? "vehicle" : null;
  let intent = topicOf(q);
  if (intent === "staff_compare" && staffNames.length < 2 && !/最好|前三|後三|top|模式|溝通|組合|不一樣|做了什麼|誰最|哪個業務最|表現最/i.test(q)) intent = "staff";
  if (intent === "overview" && by === "staff") intent = "staff";
  if ((intent === "overview" || intent === "deals") && by === "vehicle") intent = "vehicle";
  const insights = await db.all("SELECT id, kind, title, summary, severity FROM insights WHERE dismissed = 0 ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id DESC LIMIT 20");
  const ctx: Ctx = { db, a, q, days, by, staffName, vehName, insights, staffNames, now: opts.to ?? new Date().toISOString() };
  const built = await BUILD[intent](ctx);
  const ids = built.evidence.map((e) => e.id);
  const dbActs = ids.length ? await db.all(`SELECT text, owner_role FROM actions WHERE insight_id IN (${ids.map(() => "?").join(",")}) AND status IN ('approved','proposed') ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, id LIMIT 3`, ...ids) : [];
  const actions = dbActs.length ? dbActs.map((r) => ({ text: String(r["text"]), owner_role: String(r["owner_role"]) })) : built.actions;
  const base: AskAnswer = { question: q, intent, period: { days, from: a.period.from, to: a.period.to }, ...built, actions, suggest: (SUGGEST[intent] ?? []).filter((s) => s !== q), mode: "template" };
  if (["coaching", "coaching_result", "decisions"].includes(intent)) return base;   // 這幾題的建議已經是規則產物，不讓 AI 改寫
  return narrate(env, a, insights, base, dbActs.length > 0);
}

/** AI 只准：改寫結論、加最多兩個假設、加最多兩個動作。每一句都過數字白名單，過不了就留規則版。 */
async function narrate(env: Env, a: Analytics, insights: Row[], base: AskAnswer, keepActions: boolean): Promise<AskAnswer> {
  if (!env.GEMINI_API_KEY) return base;
  const facts = factsPack(a, insights);
  const numLines = base.numbers.map((n) => `${n.label}：${n.value}${n.sub ? `（${n.sub}）` : ""}`).join("\n");
  const factLines = base.reasons.filter((r) => r.claim === "fact").map((r) => r.text).join("\n");
  const allowed = new Set([...facts.allowed, ...numbersIn(numLines), ...numbersIn(factLines), ...numbersIn(base.conclusion)]);
  const prompt = `你是中古車公司老闆的幕僚。老闆問：「${base.question}」
系統已經算好這題的數字（下面），你只做三件事，繁體中文、像顧問跟老闆講話、不客套：
  "conclusion"：一到兩句直接回答老闆的問題，只能用下面出現過的數字
  "reasons"：最多兩個可能的原因（這是假設，不是事實，不要寫成結論）
  "actions"：最多兩個明天就能做的具體動作，各註明 owner_role（ceo / manager / staff）
規則：不准自己算、不准編新的百分比或金額；不確定就說「可能」。
嚴格輸出 JSON：{"conclusion":"…","reasons":["…"],"actions":[{"text":"…","owner_role":"manager"}]}

【這題的關鍵數據】
${numLines}
${factLines}
規則版結論：${base.conclusion}

【事實包】
${facts.text}`;
  let p: { conclusion?: string; reasons?: string[]; actions?: Array<{ text?: string; owner_role?: string }> };
  try { p = await gemini(env, prompt) as typeof p; } catch { return base; }
  const out: AskAnswer = { ...base };
  let used = false;
  const concl = String(p.conclusion ?? "").slice(0, 400);
  if (concl && !violates(concl, allowed)) { out.conclusion = concl; used = true; }
  const hyp = (Array.isArray(p.reasons) ? p.reasons : []).map((t) => String(t).slice(0, 240)).filter((t) => t && !violates(t, allowed)).slice(0, 2);
  if (hyp.length) { out.reasons = [...base.reasons.filter((r) => r.claim === "fact"), ...hyp.map((t) => ({ text: t, claim: "hypothesis" as const })), ...base.reasons.filter((r) => r.claim === "hypothesis")].slice(0, 5); used = true; }
  if (!keepActions) {
    const acts = (Array.isArray(p.actions) ? p.actions : []).filter((x) => x && x.text && !violates(String(x.text), allowed)).slice(0, 2)
      .map((x) => ({ text: String(x.text).slice(0, 300), owner_role: ["ceo", "manager", "staff"].includes(String(x.owner_role)) ? String(x.owner_role) : "manager" }));
    if (acts.length) { out.actions = acts; used = true; }
  }
  out.mode = used ? "ai" : "template";
  return out;
}
