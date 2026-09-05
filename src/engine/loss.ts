/**
 * 流失原因引擎 —— 每一位未成交（或推定流失）的客戶：哪裡掉 ＋ 為什麼掉 ＋ 信心 ＋ 證據。
 *
 * 判定順序（規則優先、AI 只補「不明」）：
 *   1. 客戶自己講的（結尾三則客戶訊息裡的明確用語）→ 那個類別；帳本原因一致 → CONFIRMED，否則 STRONGLY_SUGGESTED
 *   2. 帳本有明確原因、對話沒明講 → 帳本類別（STRONGLY_SUGGESTED，註明「帳本標記」）
 *   3. 對話訊號：業務說沒車→無車可賣；爽約後沒再約→預約爽約；貸款沒答→貸款問題；議價後沒成交→議價破局；價格異議→價格抗拒
 *   4. 客戶問了問題業務沒回 → 業務回覆太慢（流程面）
 *   5. 只有沉默 → 客戶停止回覆（POSSIBLE），副因看流程：沉默後沒跟進＝跟進不足、首次回覆太慢＝回覆太慢
 *   6. 都沒有 → 不明／證據不足
 *
 * 每一列都指到訊息（evidence.loss_id）。不確定的推論一律標 POSSIBLE，畫面不准當事實。
 */
import type { DbLike } from "../adapters/import.ts";
import type { LossReasonKey } from "../model/types.ts";

type Row = Record<string, unknown>;
const H = 3_600_000, D = 24 * H;
const num = (v: unknown) => Number(v ?? 0) || 0;
interface Msg { id: number; role: string; text: string; at: number }

export const LOSS_LABEL: Record<LossReasonKey, string> = {
  price_resistance: "價格抗拒", financing: "貸款問題", vehicle_mismatch: "車款不符", vehicle_condition: "車況疑慮", trade_in: "舊車折抵談不攏",
  timing: "時機未到", family: "家人決定", bought_elsewhere: "別家買了", no_stock: "無車可賣", slow_response: "業務回覆太慢",
  weak_followup: "跟進不足", no_show: "預約爽約", stopped_replying: "客戶停止回覆", browsing: "隨便看看", negotiation_failed: "議價破局",
  other: "其他", unclear: "不明／證據不足",
};
/** 流程面（公司可以改的）vs 客戶面 */
export const PROCESS_REASONS: LossReasonKey[] = ["slow_response", "weak_followup"];

/** 帳本原因 → 分類鍵 */
const LEDGER: Record<string, LossReasonKey> = {
  price: "price_resistance", financing: "financing", competitor: "bought_elsewhere", changed_mind: "timing", vehicle_gone: "no_stock",
  vehicle_condition: "vehicle_condition", vehicle_mismatch: "vehicle_mismatch", trade_in: "trade_in", timing: "timing", family: "family",
  no_stock: "no_stock", browsing: "browsing", other: "other",
};
/** 客戶用語（順序＝優先權：越具體越前面） */
const TXT: Array<[LossReasonKey, RegExp]> = [
  ["slow_response",     /久才回|回太慢|都沒回|怎麼沒回|沒人回/],
  ["bought_elsewhere",  /別家|跟朋友買|已經(訂|買)了|其他車行/],
  ["family",            /(老婆|老公|家人|爸媽|太太|家裡).*(討論|不同意|反對|不讓|說不)|不同意|反對/],   // 「老婆說這週要定」不是家人反對
  ["trade_in",          /舊車估價|折抵|估價差|收購價/],
  ["vehicle_condition", /事故|泡水|里程(太|有點)|底盤|異音|擔心車況|車況.*(擔心|不放心|有問題)/],   // 開場問「車況怎麼樣」不算疑慮
  ["vehicle_mismatch",  /不太適合|空間不夠|太小|太大|不是我要的|想看別款|別的車型|顏色/],
  ["no_stock",          /我要的是那台|那台.*(沒了|賣掉)/],
  ["financing",         /貸款沒過|沒過|頭期湊不|信用.*(不行|沒過)|辦不過/],
  ["browsing",          /先看看|隨便看|只是看看|沒有要買|參考一下|只是參考/],
  ["timing",            /年底|過年|再等|不急|下個月|明年|還沒決定|再看好了/],
  ["price_resistance",  /預算不夠|太貴|差太多|價格.*(差|高)|超出預算|預算只有|便宜/],
  ["timing",            /先不換|先不買|不換了|不買了/],                     // 最後才看這種「先不要」：同一句有更具體原因時讓給前面
];
const STAFF_NOSTOCK = /賣掉了|已售|沒有現車|訂走|已經賣/;
const STAGE_ORDER: Array<[string, string]> = [["NEW_LEAD", "new"], ["VEHICLE_INTEREST", "interest"], ["ACTIVE_DISCUSSION", "discussion"], ["PRICE_MENTIONED", "price"], ["APPOINTMENT_BOOKED", "appointment"], ["STORE_VISIT", "visit"], ["NEGOTIATION", "negotiation"]];
export const STAGE_LABEL: Record<string, string> = { new: "新進線", interest: "車款興趣", discussion: "有來有往", price: "報價", appointment: "預約", visit: "到店", negotiation: "議價" };

export interface LossResult {
  status: "lost" | "suspected"; primary: LossReasonKey; secondary: LossReasonKey | ""; alt: LossReasonKey | ""; driver: "customer" | "process" | "unclear";
  confidence: "CONFIRMED" | "STRONGLY_SUGGESTED" | "POSSIBLE" | "UNCLEAR"; stage: string; summary: string;
  evidence: Array<{ message_id: number; note: string }>;
  appointment_status: string; visit_status: string; first_at: string | null; last_customer_at: string | null; last_staff_at: string | null;
}

export interface LossCtx {
  msgs: Msg[]; events: Row[]; deal: Row | null; appts: Row[]; visits: Row[]; outcome: string; now: number;
  /** 對話涵蓋程度：不是 full 就不判「回覆太慢」「跟進不足」（回覆可能在電話或 LINE 官方後台） */
  coverage?: string;
  /** 估車群的紀錄（有的話）：客人想要的價格高於權威／天書，是舊車折抵談不攏的線索 */
  appraisal?: Row | null;
}

/** 純函式：一個 lead 的流失分析（呼叫端已確定它是 lost 或推定流失） */
export function analyzeLoss(c: LossCtx): LossResult {
  const msgs = c.msgs, cust = msgs.filter((m) => m.role === "customer"), staff = msgs.filter((m) => m.role === "staff");
  const covered = !c.coverage || c.coverage === "full";
  const ev = (t: string) => c.events.filter((e) => String(e["type"]) === t && String(e["confidence"]) !== "UNCLEAR");
  const evAt = (e: Row) => Date.parse(String(e["at"]));
  const evidence: LossResult["evidence"] = [];
  const push = (m: Msg | undefined, note: string) => { if (m && !evidence.some((x) => x.message_id === m.id)) evidence.push({ message_id: m.id, note }); };
  const lastC = cust[cust.length - 1], lastS = staff[staff.length - 1], last = msgs[msgs.length - 1];
  const ledgerKey = c.deal ? (LEDGER[String(c.deal["lost_reason"] || "")] ?? null) : null;

  /* 1. 客戶自己講的 */
  const closing = cust.slice(-3);
  let said: { key: LossReasonKey; m: Msg } | null = null;
  // 最後一則優先：客戶最後講的才是結案理由（「回去跟家人討論」之後說「預算不夠」，主因是預算）
  outer: for (const m of [...closing].reverse()) for (const [key, re] of TXT) if (re.test(m.text)) { said = { key, m }; break outer; }
  let anywhere: { key: LossReasonKey; m: Msg } | null = null;
  if (!said) outer2: for (const [key, re] of TXT) for (const m of cust) if (re.test(m.text)) { anywhere = { key, m }; break outer2; }

  /* 訊號 */
  const objection = ev("PRICE_OBJECTION")[0];
  const negotiation = ev("NEGOTIATION")[0];
  const noshow = ev("NO_SHOW")[0];
  const bookedAfterNoshow = noshow ? ev("APPOINTMENT_BOOKED").some((e) => evAt(e) > evAt(noshow)) || c.visits.length > 0 : false;
  const fin = ev("FINANCING_QUESTION")[0];
  let finResolved: boolean | null = null; if (fin) { try { finResolved = !!JSON.parse(String(fin["detail"] || "{}"))["resolved"]; } catch { finResolved = null; } }
  const noStockMsg = staff.find((m) => STAFF_NOSTOCK.test(m.text));
  const priceMsg = staff.find((m) => /(\d{2,3})\s*萬|報價|含過戶/.test(m.text));
  const firstC = cust[0]; const firstS = firstC ? staff.find((m) => m.at > firstC.at) : undefined;
  const firstRespH = firstC && firstS ? (firstS.at - firstC.at) / H : (firstC ? (c.now - firstC.at) / H : 0);
  const unanswered = covered && !!lastC && !staff.some((m) => m.at > lastC.at) && /[？?]|嗎|多少|什麼時候|哪|怎麼/.test(lastC.text);
  const silentH = lastC ? (c.now - lastC.at) / H : 0;
  const followedAfterSilence = !!lastC && staff.some((m) => m.at > lastC.at + 24 * H && m.at <= lastC.at + 7 * D);
  const noFollowup = covered && !!lastC && silentH >= 72 && !followedAfterSilence;

  const promised = covered && !!lastS && !!lastC && lastS.at > lastC.at && /再跟您說|再確認|再幫您問|問一下|稍等|再回覆|再跟您回/.test(lastS.text)
    && !staff.some((m) => m.at > lastS.at) && c.now - lastS.at >= 72 * H;          // 業務說要再回，結果沒回
  let primary: LossReasonKey = "unclear", conf: LossResult["confidence"] = "UNCLEAR", note = "";
  if (said && said.key === "price_resistance" && negotiation) {
    primary = "negotiation_failed"; conf = "CONFIRMED"; push(msgs.find((m) => m.at === evAt(negotiation)), "客戶出價"); push(said.m, `客戶明說：「${said.m.text.slice(0, 40)}」`); note = "出過價、最後說價格談不攏";
  } else if (said) {
    primary = said.key; conf = ledgerKey === said.key || !ledgerKey || ledgerKey === "other" ? "CONFIRMED" : "STRONGLY_SUGGESTED";
    push(said.m, `客戶明說：「${said.m.text.slice(0, 40)}」`); note = "客戶自己講的";
  } else if (ledgerKey && !["stopped_replying", "other"].includes(ledgerKey)) {
    primary = ledgerKey; conf = "STRONGLY_SUGGESTED"; note = "帳本標記，對話沒有明講";
    push(anywhere?.key === ledgerKey ? anywhere.m : lastC, "帳本原因；這是最後一則客戶訊息");
  } else if (noStockMsg) { primary = "no_stock"; conf = "STRONGLY_SUGGESTED"; push(noStockMsg, "業務說車已售出"); note = "業務說沒車"; }
  else if (noshow && !bookedAfterNoshow) { primary = "no_show"; conf = "STRONGLY_SUGGESTED"; push(msgs.find((m) => Math.abs(m.at - evAt(noshow)) < 6 * H), "爽約前後的訊息"); note = "爽約後沒有再約成"; }
  else if (fin && finResolved === false && silentH >= 48) { primary = "financing"; conf = "STRONGLY_SUGGESTED"; push(msgs.find((m) => m.at === evAt(fin)) ?? cust.find((m) => /貸|頭期|利率|月付/.test(m.text)), "客戶問貸款"); push(staff.find((m) => m.at > evAt(fin)), "業務沒有給具體答案"); note = "貸款問題沒有得到答案，之後沉默"; }
  else if (negotiation && lastC && /(\d{2,3})\s*萬|再少|便宜|成交|價格/.test(lastC.text)) { primary = "negotiation_failed"; conf = "STRONGLY_SUGGESTED"; push(msgs.find((m) => m.at === evAt(negotiation)), "客戶出價"); push(lastC, "最後一則仍在談價"); note = "出過價但沒談攏"; }
  else if (objection) { primary = "price_resistance"; conf = "STRONGLY_SUGGESTED"; push(priceMsg, "報價"); push(msgs.find((m) => m.at === evAt(objection)) ?? cust.find((m) => /貴|預算|便宜/.test(m.text)), "客戶對價格表達異議"); note = "價格異議後沒有走下去"; }
  else if (promised) { primary = "weak_followup"; conf = "STRONGLY_SUGGESTED"; push(lastC, "客戶在等答案"); push(lastS, "業務說會再回覆，之後沒有下文"); note = "業務承諾回覆卻沒有回"; }
  else if (unanswered) { primary = "slow_response"; conf = "STRONGLY_SUGGESTED"; push(lastC, "客戶的問題沒有人回"); note = "客戶最後問了問題，業務沒有回覆"; }
  else if (lastC && silentH >= 72) { primary = "stopped_replying"; conf = "POSSIBLE"; push(lastC, "最後一則客戶訊息，之後沉默"); note = !covered ? "訊息涵蓋不完整（可能有電話或官方後台回覆），不判流程面" : anywhere ? `對話較早曾提到${LOSS_LABEL[anywhere.key]}` : "沒有明講原因"; }
  else if (ledgerKey === "other") { primary = "other"; conf = "POSSIBLE"; push(lastC, "帳本標其他"); }

  /* 副因：流程面（涵蓋不完整就不判） */
  let secondary: LossReasonKey | "" = "";
  if (!PROCESS_REASONS.includes(primary)) {
    if (noFollowup && primary !== "no_show") { secondary = "weak_followup"; push(lastS, "沉默後最後一則業務訊息（之後 7 天沒有再跟進）"); }
    else if (covered && firstRespH >= 4 && primary === "stopped_replying") { secondary = "slow_response"; push(firstS, `首次回覆花了 ${Math.round(firstRespH)} 小時`); }
    else if (noshow && !bookedAfterNoshow && primary !== "no_show") secondary = "no_show";
    else if (fin && finResolved === false && primary !== "financing") secondary = "financing";
    else if (objection && primary !== "price_resistance" && primary !== "negotiation_failed") secondary = "price_resistance";
  } else if (objection) secondary = "price_resistance";
  /* 替代可能：另一個較弱的文字訊號 */
  let alt: LossReasonKey | "" = "";
  if (anywhere && anywhere.key !== primary && anywhere.key !== secondary) { alt = anywhere.key; push(anywhere.m, `替代可能：${LOSS_LABEL[anywhere.key]}`); }
  else if (said && anywhere && anywhere.key !== said.key) alt = anywhere.key;
  if (primary === "negotiation_failed" && !alt) alt = "price_resistance";
  /* 估車群：車換車的客人開價高於權威／天書 → 舊車折抵是線索（只當替代可能，不當主因） */
  let apprNote = "";
  if (c.appraisal) {
    const ask = num(c.appraisal["customer_ask"]), q = num(c.appraisal["book_quanwei"]), t = num(c.appraisal["book_tianshu"]);
    const best = Math.max(q, t);
    apprNote = `估車：${String(c.appraisal["model_text"] || "舊車")}${ask ? `，客人想要 ${Math.round(ask / 10_000)} 萬` : ""}${best ? `，權威 ${Math.round(q / 10_000)}／天書 ${Math.round(t / 10_000)} 萬` : ""}`;
    if (String(c.appraisal["mode"]) === "trade_in" && ask && best && ask > best * 1.1 && primary !== "trade_in" && !alt) { alt = "trade_in"; apprNote += "，高於行情"; }
  }
  const driver: LossResult["driver"] = PROCESS_REASONS.includes(primary) ? "process" : (primary === "stopped_replying" ? (secondary === "weak_followup" || secondary === "slow_response" ? "process" : "unclear") : primary === "unclear" ? "unclear" : "customer");

  /* 哪裡掉 */
  let stage = "new";
  for (const [t, s] of STAGE_ORDER) if (ev(t).length) stage = s;
  push(priceMsg, "報價");
  const lastAppt = c.appts[c.appts.length - 1];
  const summary = [
    `在「${STAGE_LABEL[stage] ?? stage}」階段之後沒有再往下走`,
    `主因 ${LOSS_LABEL[primary]}（${note || "依對話訊號判定"}）`,
    secondary ? `副因 ${LOSS_LABEL[secondary]}` : "",
    alt ? `替代可能 ${LOSS_LABEL[alt]}` : "",
    apprNote,
    lastC ? `最後一則客戶訊息後沉默 ${Math.round(silentH / 24)} 天` : "",
    !covered ? "訊息涵蓋不完整" : "",
  ].filter(Boolean).join("；") + "。";
  if (c.outcome !== "lost" && (conf === "CONFIRMED" || conf === "STRONGLY_SUGGESTED")) conf = "POSSIBLE";   // 推定流失的原因最多只能「可能」
  return {
    status: c.outcome === "lost" ? "lost" : "suspected", primary, secondary, alt, driver, confidence: conf, stage, summary,
    evidence: evidence.slice(0, 6),
    appointment_status: lastAppt ? String(lastAppt["status"]) : "", visit_status: c.visits.length ? String(c.visits[c.visits.length - 1]!["outcome"]) : "",
    first_at: msgs[0] ? new Date(msgs[0].at).toISOString() : null, last_customer_at: lastC ? new Date(lastC.at).toISOString() : null,
    last_staff_at: lastS ? new Date(lastS.at).toISOString() : null,
  };
}

/** 跑全部流失＋推定流失的 lead，重寫 loss_analyses 與證據 */
export async function computeLoss(db: DbLike, opts: { now: string; leadIds?: number[] }): Promise<{ analyzed: number; lost: number; suspected: number; by_reason: Record<string, number> }> {
  const now = Date.parse(opts.now);
  const where = opts.leadIds?.length ? `l.id IN (${opts.leadIds.map(() => "?").join(",")})` : "1=1";
  const leads = await db.all(
    `SELECT l.* FROM leads l WHERE ${where} AND (l.outcome = 'lost' OR (l.outcome = '' AND EXISTS (SELECT 1 FROM funnel_events e WHERE e.lead_id = l.id AND e.type = 'LOST' AND e.detail LIKE '%"inferred":true%')))`,
    ...(opts.leadIds ?? []));
  if (opts.leadIds?.length) { await db.run(`DELETE FROM evidence WHERE loss_id IN (SELECT id FROM loss_analyses WHERE lead_id IN (${opts.leadIds.map(() => "?").join(",")}))`, ...opts.leadIds); await db.run(`DELETE FROM loss_analyses WHERE lead_id IN (${opts.leadIds.map(() => "?").join(",")})`, ...opts.leadIds); }
  else { await db.run("DELETE FROM evidence WHERE loss_id IS NOT NULL"); await db.run("DELETE FROM loss_analyses"); }
  const by: Record<string, number> = {}; let lost = 0, suspected = 0;
  for (const l of leads) {
    const lid = num(l["id"]);
    const msgs: Msg[] = (await db.all(`SELECT m.id, m.sender_role, m.text, m.created_at FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.lead_id = ? ORDER BY m.created_at, m.id`, lid))
      .map((m) => ({ id: num(m["id"]), role: String(m["sender_role"]), text: String(m["text"]), at: Date.parse(String(m["created_at"])) }));
    const r = analyzeLoss({
      msgs, events: await db.all("SELECT type, at, confidence, detail FROM funnel_events WHERE lead_id = ? ORDER BY at", lid),
      deal: await db.first("SELECT * FROM deals WHERE lead_id = ? AND status = 'lost' ORDER BY id LIMIT 1", lid),
      appts: await db.all("SELECT * FROM appointments WHERE lead_id = ? ORDER BY proposed_at", lid),
      visits: await db.all("SELECT * FROM visits WHERE lead_id = ? ORDER BY visited_at", lid),
      outcome: String(l["outcome"] ?? ""), now,
      coverage: String((await db.first("SELECT coverage FROM conversations WHERE lead_id = ? ORDER BY id LIMIT 1", lid))?.["coverage"] ?? "full"),
      appraisal: await db.first("SELECT * FROM appraisals WHERE lead_id = ? ORDER BY reported_at DESC LIMIT 1", lid),
    });
    const ins = await db.run(
      `INSERT INTO loss_analyses (lead_id, status, primary_reason, secondary_reason, alt_reason, driver, confidence, stage, staff_id, vehicle_id, appointment_status, visit_status, first_at, last_customer_at, last_staff_at, closed_at, summary, method, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'rule',?)`,
      lid, r.status, r.primary, r.secondary, r.alt, r.driver, r.confidence, r.stage, l["staff_id"] ?? null, l["vehicle_id"] ?? null,
      r.appointment_status, r.visit_status, r.first_at, r.last_customer_at, r.last_staff_at, l["closed_at"] ?? null, r.summary, opts.now);
    for (const e of r.evidence) await db.run("INSERT INTO evidence (loss_id, message_id, lead_id, note) VALUES (?,?,?,?)", ins.lastRowId, e.message_id, lid, e.note);
    by[r.primary] = (by[r.primary] ?? 0) + 1; if (r.status === "lost") lost++; else suspected++;
  }
  return { analyzed: leads.length, lost, suspected, by_reason: by };
}

/* ── 彙總視圖：本期 vs 前期、分項（業務／車款／車型／階段／價格帶／組別）、清單 ── */
const rateOf = (k: number, n: number) => (n > 0 ? Math.round((k / n) * 1000) / 1000 : null);
const bandOf = (price: number) => (price <= 0 ? "未知" : price < 800_000 ? "入門（<80 萬）" : price < 1_300_000 ? "中階（80–130 萬）" : "高階（130 萬+）");
export interface LossGroup { label: string; n: number; top: Array<{ key: string; label: string; k: number; rate: number | null }>; process: number; lead_ids: number[] }
export async function lossAggregate(db: DbLike, opts: { days?: number; to?: string; reason?: string }) {
  const days = opts.days ?? 30; const toT = opts.to ? Date.parse(opts.to) : Date.now(); const fromT = toT - days * D, pFromT = fromT - days * D;
  const rows = await db.all(`SELECT la.lead_id, la.status, la.primary_reason, la.secondary_reason, la.alt_reason, la.driver, la.confidence, la.stage, la.summary, la.closed_at, la.last_customer_at,
      l.opened_at, l.staff_id, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact, COALESCE(u.name,'未指派') AS staff, COALESCE(t.name,'') AS team,
      COALESCE(v.brand||' '||v.model,'') AS vehicle, COALESCE(v.body_type,'') AS body_type, COALESCE(v.list_price,0) AS list_price
     FROM loss_analyses la JOIN leads l ON l.id = la.lead_id JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = l.staff_id LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN vehicles v ON v.id = l.vehicle_id`);
  const inW = (r: Row, a: number, b: number) => { const t = Date.parse(String(r["closed_at"] || r["opened_at"])); return t >= a && t < b; };
  const cur = rows.filter((r) => r["status"] === "lost" && inW(r, fromT, toT)), prev = rows.filter((r) => r["status"] === "lost" && inW(r, pFromT, fromT));
  const suspected = rows.filter((r) => r["status"] === "suspected");
  const count = (set: Row[]) => { const c: Record<string, number> = {}; for (const r of set) { const k = String(r["primary_reason"]); c[k] = (c[k] ?? 0) + 1; } return c; };
  const cc = count(cur), pc = count(prev);
  const L = LOSS_LABEL as Record<string, string>;
  const reasons = [...new Set([...Object.keys(cc), ...Object.keys(pc)])].map((k) => ({ key: k, label: L[k] ?? k, k: cc[k] ?? 0, prev_k: pc[k] ?? 0, rate: rateOf(cc[k] ?? 0, cur.length), delta: (cc[k] ?? 0) - (pc[k] ?? 0), process: (PROCESS_REASONS as string[]).includes(k) })).sort((a, b) => b.k - a.k);
  const driver = { customer: cur.filter((r) => r["driver"] === "customer").length, process: cur.filter((r) => r["driver"] === "process").length, unclear: cur.filter((r) => r["driver"] === "unclear").length };
  const dims: Record<string, (r: Row) => string> = { staff: (r) => String(r["staff"]), vehicle: (r) => String(r["vehicle"] || "未知"), body: (r) => String(r["body_type"] || "未分類"), stage: (r) => STAGE_LABEL[String(r["stage"])] ?? String(r["stage"]), band: (r) => bandOf(num(r["list_price"])), team: (r) => String(r["team"] || "未分組") };
  const by: Record<string, LossGroup[]> = {};
  for (const [dim, f] of Object.entries(dims)) {
    const g = new Map<string, Row[]>(); for (const r of cur) { const k = f(r); if (!g.has(k)) g.set(k, []); g.get(k)!.push(r); }
    by[dim] = [...g.entries()].map(([label, set]) => { const c = count(set); return { label, n: set.length, top: Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, k]) => ({ key, label: L[key] ?? key, k, rate: rateOf(k, set.length) })), process: set.filter((r) => r["driver"] === "process").length, lead_ids: set.slice(0, 8).map((r) => num(r["lead_id"])) }; }).sort((a, b) => b.n - a.n);
  }
  const shape = (r: Row) => ({ lead_id: num(r["lead_id"]), contact: String(r["contact"]), staff: String(r["staff"]), team: String(r["team"]), vehicle: String(r["vehicle"]), list_price: num(r["list_price"]), stage: String(r["stage"]), stage_label: STAGE_LABEL[String(r["stage"])] ?? String(r["stage"]),
    reason: String(r["primary_reason"]), reason_label: L[String(r["primary_reason"])] ?? String(r["primary_reason"]), secondary: String(r["secondary_reason"] || ""), secondary_label: r["secondary_reason"] ? (L[String(r["secondary_reason"])] ?? String(r["secondary_reason"])) : "", alt_label: r["alt_reason"] ? (L[String(r["alt_reason"])] ?? String(r["alt_reason"])) : "",
    driver: String(r["driver"]), confidence: String(r["confidence"]), summary: String(r["summary"]), closed_at: r["closed_at"] ?? null, last_customer_at: r["last_customer_at"] ?? null, status: String(r["status"]) });
  const list = (opts.reason ? cur.filter((r) => r["primary_reason"] === opts.reason) : cur).sort((a, b) => String(b["closed_at"]).localeCompare(String(a["closed_at"]))).slice(0, 60).map(shape);
  return { period: { from: new Date(fromT).toISOString(), to: new Date(toT).toISOString(), days }, totals: { lost: cur.length, prev: prev.length, suspected: suspected.length }, reasons, driver, by, list, suspected: suspected.slice(0, 30).map(shape) };
}
