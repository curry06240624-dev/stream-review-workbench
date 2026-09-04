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

type Row = Record<string, unknown>;
interface Env { GEMINI_API_KEY?: string; GEMINI_MODEL?: string; }
export type Intent = "overview" | "price_dropoff" | "staff" | "vehicle" | "appointments" | "deals" | "attention";
export interface AskNumber { label: string; value: string; sub?: string; href?: string }
export interface AskChart { type: "bar" | "line"; labels: string[]; series: Array<{ label: string; data: number[]; style?: "bar" | "line"; tone?: "neutral" | "warn" | "accent" }> }
export interface AskAnswer {
  question: string; intent: Intent; period: { days: number; from: string; to: string };
  conclusion: string; numbers: AskNumber[];
  reasons: Array<{ text: string; claim: "fact" | "hypothesis" }>;
  leads: Array<{ id: number; contact: string; staff: string; vehicle: string; note: string }>;
  evidence: Array<{ id: number; title: string; severity: string }>;
  actions: Array<{ text: string; owner_role: string }>;
  how: string[]; chart: AskChart | null; suggest: string[]; mode: "ai" | "template";
}
type Built = Pick<AskAnswer, "conclusion" | "numbers" | "reasons" | "leads" | "evidence" | "actions" | "how" | "chart">;
interface Ctx { db: DbLike; a: Analytics; q: string; days: number; by: "staff" | "vehicle" | null; staffName: string | null; vehName: string | null; insights: Row[] }

const D = 86_400_000, TZ = 8 * 3_600_000;
const num = (v: unknown) => Number(v ?? 0) || 0;
const P = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const W = (n: number) => `${Math.round(n / 10000).toLocaleString("zh-TW")} 萬`;
const md = (iso: string) => { const d = new Date(Date.parse(iso) + TZ); return `${d.getUTCMonth() + 1}/${String(d.getUTCDate()).padStart(2, "0")}`; };
const hrs = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 3_600_000));
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

async function weekly(db: DbLike, weeks = 8) {
  const now = Date.now();
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
  const weeks = await weekly(db, 8);
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
    WHERE NOT EXISTS (SELECT 1 FROM visits vi WHERE vi.lead_id = x.id) ORDER BY ap.scheduled_for DESC LIMIT 8`, new Date().toISOString());
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
  const weeks = await weekly(db, 8);
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
  const weeks = await weekly(db, 8);
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
  if (oldest) reasons.push({ text: `等最久的是 ${oldest.contact}（${KIND[oldest.kind] ?? oldest.kind}，已等 ${hrs(oldest.since)} 小時）。`, claim: "fact" });
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

const BUILD: Record<Intent, (c: Ctx) => Promise<Built>> = { overview: overviewB, price_dropoff: priceDropoff, staff: staffB, vehicle: vehicleB, appointments: appointmentsB, deals: dealsB, attention: attentionB };
const SUGGEST: Record<Intent, string[]> = {
  overview: ["為什麼這週報價後客戶都不回？", "今天我該先處理誰？", "哪個業務毛利最高？"],
  price_dropoff: ["哪個業務報價後流失最多？", "哪款車報價後最容易流失？", "報價後沒回的客戶誰還沒人跟進？"],
  staff: ["哪個業務報價後流失最多？", "哪個業務回覆最慢？", "哪個業務毛利最高？"],
  vehicle: ["哪台車詢問最多但最少成交？", "哪款車報價後最容易流失？", "詢問最多的車成交幾台？"],
  appointments: ["預約已過但沒到店的有誰？", "這個月爽約幾位？", "到店後沒成交的原因是什麼？"],
  deals: ["這個月哪個業務毛利最高？", "有沒有低於成本的成交？", "流失原因最多的是什麼？"],
  attention: ["急迫但沒人跟進的客戶有誰？", "報價後沒回的客戶誰還沒人跟進？", "預約已過但沒到店的有誰？"],
};

/* ── 3. 入口與 AI 敘事 ── */
export async function answer(db: DbLike, env: Env, q: string): Promise<AskAnswer> {
  const days = parseDays(q);
  const a = await computeAnalytics(db, { days });
  const staffList = await db.all("SELECT name FROM users WHERE role = 'agent'");
  const vehList = await db.all("SELECT brand, model FROM vehicles");
  const lq = q.toLowerCase();
  const staffName = staffList.map((r) => String(r["name"] ?? "")).find((n) => n.length >= 2 && q.includes(n)) ?? null;
  const vehName = vehList.map((r) => `${r["brand"]} ${r["model"]}`).find((n) => { const m = n.split(" ").slice(1).join(" ").toLowerCase(); return lq.includes(n.toLowerCase()) || (m.length >= 2 && lq.includes(m)); }) ?? null;
  const by: Ctx["by"] = staffName || /業務|哪個人|誰的|誰報|回覆速度|回得|跟進次數|一組|二組/.test(q) ? "staff" : vehName || /車款|哪台車|哪款|哪一台|熱門|詢問度|車型|休旅|轎車/.test(q) ? "vehicle" : null;
  let intent = topicOf(q);
  if (intent === "overview" && by === "staff") intent = "staff";
  if ((intent === "overview" || intent === "deals") && by === "vehicle") intent = "vehicle";
  const insights = await db.all("SELECT id, kind, title, summary, severity FROM insights WHERE dismissed = 0 ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id DESC LIMIT 20");
  const ctx: Ctx = { db, a, q, days, by, staffName, vehName, insights };
  const built = await BUILD[intent](ctx);
  const ids = built.evidence.map((e) => e.id);
  const dbActs = ids.length ? await db.all(`SELECT text, owner_role FROM actions WHERE insight_id IN (${ids.map(() => "?").join(",")}) AND status IN ('approved','proposed') ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, id LIMIT 3`, ...ids) : [];
  const actions = dbActs.length ? dbActs.map((r) => ({ text: String(r["text"]), owner_role: String(r["owner_role"]) })) : built.actions;
  const base: AskAnswer = { question: q, intent, period: { days, from: a.period.from, to: a.period.to }, ...built, actions, suggest: (SUGGEST[intent] ?? []).filter((s) => s !== q), mode: "template" };
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
