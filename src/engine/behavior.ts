/**
 * 訊息層行為特徵 —— 「表現好的人做了什麼不一樣」的原料。
 *
 * 每個 lead 一列，每個特徵帶值與指向的訊息（沒有訊息就沒有特徵）。只有「情境出現過」才會有那個鍵：
 * 沒報過價就沒有 asked_after_price、客戶沒說太貴就沒有 objection_clarified —— 這樣員工之間比的才是同一種情境。
 *
 * 全部是規則，AI 不碰。規則改了要重跑 scripts/eval_loss.mjs 的行為特徵段。
 */
import type { DbLike } from "../adapters/import.ts";

type Row = Record<string, unknown>;
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const num = (v: unknown) => Number(v ?? 0) || 0;
export interface Msg { id: number; role: string; uid: number; text: string; at: number; type: string }
export interface Feature { v: number | null; msg?: number | null; n?: number }
export type Features = Record<string, Feature>;

export const B = {
  question:  /[？?]|嗎|多少|哪|什麼|怎麼|要不要|方便|如何|覺得/,
  price:     /(\d{2,3})\s*萬|報價|含過戶|NT\$\s*\d/,
  budget:    /預算/,
  apptProp:  /約個時間|方便嗎|有空嗎|來店|來看車|留車|哪天有空|來看實車|安排看車|排看車/,
  clarify:   /預算|方案|爭取|幫您|多少|哪|什麼|月付|總價|數字/,
  /** 具體的看車邀約：要有時間或「約」的字眼，「可以來看車現場再談」這種順口話不算 */
  apptOffer: /(約|方便|有空|哪天|什麼時候|時段|週[一二三四五六日]|禮拜|明天|後天|下午|早上|晚上|\d\s*點).*(看車|來店|過來|賞車|來看|留車)|(看車|來店|賞車).*(約|方便嗎|有空嗎|哪天|時段|時間)|(排|安排)看車/,
};
/** 特徵的中文名與方向（畫面與問 AI 共用） */
export const FEATURE_LABEL: Record<string, { label: string; unit: "rate" | "min" | "hour" | "num" | "pct"; goodIsUp: boolean; situation: string }> = {
  first_response_min:  { label: "首次回覆時間", unit: "min", goodIsUp: false, situation: "每個客戶" },
  median_response_min: { label: "回覆中位數", unit: "min", goodIsUp: false, situation: "有客戶訊息" },
  followup_24h_rate:   { label: "客戶沉默後 24 小時內跟進", unit: "rate", goodIsUp: true, situation: "客戶沉默 ≥24 小時" },
  asked_after_price:   { label: "報價後接一個問題", unit: "rate", goodIsUp: true, situation: "有報價" },
  objection_clarified: { label: "價格異議後先釐清", unit: "rate", goodIsUp: true, situation: "客戶說太貴" },
  proposed_after_intent: { label: "高意圖後主動約看車", unit: "rate", goodIsUp: true, situation: "客戶表達急迫" },
  fin_answered:        { label: "貸款問題給具體答案", unit: "rate", goodIsUp: true, situation: "客戶問貸款" },
  postvisit_24h:       { label: "到店後 24 小時內跟進", unit: "rate", goodIsUp: true, situation: "到店沒當場買" },
  budget_clarified:    { label: "開場就問預算", unit: "rate", goodIsUp: true, situation: "每個客戶" },
  opening_question:    { label: "開場第一句就問問題", unit: "rate", goodIsUp: true, situation: "每個客戶" },
  questions_per_msg:   { label: "每則訊息的提問率", unit: "rate", goodIsUp: true, situation: "業務訊息" },
  reactivated_by_staff: { label: "沉默客戶被業務叫回來", unit: "rate", goodIsUp: true, situation: "客戶沉默 ≥7 天" },
  escalated:           { label: "找主管或同事協助", unit: "rate", goodIsUp: true, situation: "每個客戶" },
  discount_pct:        { label: "成交折讓（佔定價）", unit: "pct", goodIsUp: false, situation: "成交" },
};

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const isQ = (t: string) => B.question.test(t);

export interface LeadCtx {
  msgs: Msg[]; events: Row[]; visits: Row[]; deal: Row | null; roles: Row[]; listPrice: number; closedAt: number; now: number;
  /** 對話涵蓋程度：不是 full 就不算回覆速度與沉默後跟進（回覆可能在電話或 LINE 官方後台）；毛利若是估算也標起來 */
  coverage?: string;
}

/** 純函式：一個 lead 的行為特徵 */
export function extractFeatures(c: LeadCtx): Features {
  const f: Features = {};
  const msgs = c.msgs, custAll = msgs.filter((m) => m.role === "customer"), staff = msgs.filter((m) => m.role === "staff");
  const cust = custAll.filter((m) => m.type !== "menu");            // 客戶自己打的字才算「在等回覆」；按選單的不算
  const staffTxt = staff.filter((m) => m.type === "text");
  if (!msgs.length) return f;
  const ev = (t: string) => c.events.filter((e) => String(e["type"]) === t && String(e["confidence"]) !== "UNCLEAR");
  const evAt = (e: Row) => Date.parse(String(e["at"]));
  const covered = !c.coverage || c.coverage === "full";

  /* 回覆速度（涵蓋不完整就不算：看不到的回覆不能當成沒回）。超過 7 天才回的不算「回覆」，算沒回（真資料有隔一年才回的） */
  const c0 = cust[0];
  if (c0 && covered) { const s0 = staff.find((m) => m.at > c0.at); if (s0 && s0.at - c0.at <= 7 * D) f["first_response_min"] = { v: Math.round((s0.at - c0.at) / MIN), msg: s0.id }; else if (s0) f["first_response_missed"] = { v: 1, msg: s0.id }; }
  const lat: number[] = [];
  for (let i = 0; i < cust.length && covered; i++) {
    const cm = cust[i]!, next = cust[i + 1];
    const s = staff.find((m) => m.at > cm.at && (!next || m.at < next.at));
    if (s && s.at - cm.at <= 7 * D) lat.push((s.at - cm.at) / MIN);
  }
  const med = median(lat); if (med != null) f["median_response_min"] = { v: Math.round(med), n: lat.length };

  /* 訊息結構 */
  f["staff_msgs"] = { v: staff.length }; f["cust_msgs"] = { v: cust.length };
  if (staffTxt.length) f["questions_per_msg"] = { v: Math.round((staffTxt.filter((m) => isQ(m.text)).length / staffTxt.length) * 100) / 100, n: staffTxt.length };
  const s1 = staff[0]; if (s1) f["opening_question"] = { v: isQ(s1.text) ? 1 : 0, msg: s1.id };

  /* 報價前後 */
  const priceMsg = staff.find((m) => B.price.test(m.text));
  const beforePrice = staff.filter((m) => !priceMsg || m.at <= priceMsg.at).slice(0, 3);
  const bq = beforePrice.find((m) => B.budget.test(m.text) && (isQ(m.text) || /了解|範圍|說一下|告訴我|抓/.test(m.text)));
  f["budget_clarified"] = { v: bq ? 1 : 0, msg: (bq ?? s1)?.id ?? null };
  if (priceMsg) {
    const nextCust = cust.find((m) => m.at > priceMsg.at);
    const tail = staff.filter((m) => m.at >= priceMsg.at && (!nextCust || m.at < nextCust.at) && m.at <= priceMsg.at + 12 * H);
    const q = tail.find((m) => isQ(m.text) && !B.apptProp.test(m.text));
    f["asked_after_price"] = { v: q ? 1 : 0, msg: (q ?? priceMsg).id };
  }
  const obj = ev("PRICE_OBJECTION")[0];
  if (obj) {
    const at = evAt(obj);
    const reply = staff.find((m) => m.at > at && m.at <= at + 24 * H);
    const clarified = !!reply && (isQ(reply.text) || B.clarify.test(reply.text));
    f["objection_clarified"] = { v: clarified ? 1 : 0, msg: reply?.id ?? null };
  }
  const hi = ev("HIGH_INTENT")[0];
  if (hi) {
    const at = evAt(hi);
    const proposed = staff.some((m) => m.at >= at && m.at <= at + 48 * H && B.apptOffer.test(m.text)) || c.events.some((e) => String(e["type"]) === "APPOINTMENT_BOOKED" && evAt(e) >= at && evAt(e) <= at + 72 * H);
    const pm = staff.find((m) => m.at >= at && B.apptOffer.test(m.text));
    f["proposed_after_intent"] = { v: proposed ? 1 : 0, msg: pm?.id ?? null };
  }
  const fin = ev("FINANCING_QUESTION")[0];
  if (fin) { let d: Row = {}; try { d = JSON.parse(String(fin["detail"] || "{}")); } catch { /* ignore */ } f["fin_answered"] = { v: d["resolved"] ? 1 : 0, msg: num(d["reply_message_id"]) || null }; }

  /* 到店後跟進（沒當場買才算） */
  const visit = c.visits.find((v) => String(v["outcome"]) !== "bought");
  if (visit) {
    const vAt = Date.parse(String(visit["visited_at"]));
    const after = staff.find((m) => m.at > vAt);
    if (after) { const h = (after.at - vAt) / H; f["postvisit_followup_h"] = { v: Math.round(h * 10) / 10, msg: after.id }; f["postvisit_24h"] = { v: h <= 24 ? 1 : 0, msg: after.id }; }
    else f["postvisit_24h"] = { v: 0, msg: null };
  }

  /* 客戶沉默後的跟進：只看「業務講完一輪」之後客戶 24 小時沒回的情況（涵蓋不完整就不算） */
  let silences = 0, followed = 0;
  for (let i = 0; i < msgs.length && covered; i++) {
    const m = msgs[i]!; if (m.role !== "staff" || m.at > c.closedAt) continue;
    const next = msgs[i + 1];
    const turnEnd = !next || next.role === "customer" || next.at - m.at >= 24 * H;
    if (!turnEnd) continue;
    const custReply = cust.find((x) => x.at > m.at && x.at <= m.at + 24 * H);
    if (custReply) continue;
    if (!next && c.now - m.at < 24 * H) continue;                       // 還沒到 24 小時，不算沉默
    silences++;
    if (staff.some((x) => x.at > m.at + 24 * H && x.at <= m.at + 7 * D && !cust.some((cm) => cm.at > m.at && cm.at < x.at))) followed++;
  }
  if (silences) f["followup_24h_rate"] = { v: Math.round((followed / silences) * 100) / 100, n: silences };

  /* 協作與回流 */
  const roleSet = new Set(c.roles.map((r) => String(r["role"])));
  f["escalated"] = { v: roleSet.has("manager") || roleSet.has("supporting") ? 1 : 0 };
  if (ev("CUSTOMER_INACTIVE").length) f["reactivated_by_staff"] = { v: roleSet.has("reactivation") ? 1 : 0 };

  /* 毛利保護（成本不知道的成交不算毛利率） */
  if (c.deal && String(c.deal["status"]) === "sold" && c.listPrice > 0) {
    const sp = num(c.deal["sale_price"]);
    f["discount_pct"] = { v: Math.round(((c.listPrice - sp) / c.listPrice) * 1000) / 1000 };
    if (sp > 0 && String(c.deal["cost_source"] ?? "ledger") !== "none") f["gp_margin"] = { v: Math.round((num(c.deal["gross_profit"]) / sp) * 1000) / 1000 };
  }
  return f;
}

/** 誰在線上回這位客戶：發最多文字訊息的員工（訊息組 vs 業務拆帳用） */
export function chatStaffOf(msgs: Msg[]): number | null {
  const cnt = new Map<number, number>();
  for (const m of msgs) if (m.role === "staff" && m.uid && m.type === "text") cnt.set(m.uid, (cnt.get(m.uid) ?? 0) + 1);
  let best: number | null = null, bestN = 0;
  for (const [uid, n] of cnt) if (n > bestN) { best = uid; bestN = n; }
  return best;
}

/** 跑全部（或指定）lead，重寫 behaviors */
export async function computeBehaviors(db: DbLike, opts: { now: string; leadIds?: number[] }): Promise<{ leads: number }> {
  const now = Date.parse(opts.now);
  const leads = opts.leadIds?.length
    ? await db.all(`SELECT l.*, v.list_price, (SELECT coverage FROM conversations cv WHERE cv.lead_id = l.id ORDER BY cv.id LIMIT 1) AS coverage FROM leads l LEFT JOIN vehicles v ON v.id = l.vehicle_id WHERE l.id IN (${opts.leadIds.map(() => "?").join(",")})`, ...opts.leadIds)
    : await db.all("SELECT l.*, v.list_price, (SELECT coverage FROM conversations cv WHERE cv.lead_id = l.id ORDER BY cv.id LIMIT 1) AS coverage FROM leads l LEFT JOIN vehicles v ON v.id = l.vehicle_id");
  for (const l of leads) {
    const lid = num(l["id"]);
    const msgs: Msg[] = (await db.all(
      `SELECT m.id, m.sender_role, m.sender_user_id, m.text, m.created_at, m.msg_type FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.lead_id = ? ORDER BY m.created_at, m.id`, lid))
      .map((m) => ({ id: num(m["id"]), role: String(m["sender_role"]), uid: num(m["sender_user_id"]), text: String(m["text"]), at: Date.parse(String(m["created_at"])), type: String(m["msg_type"] ?? "text") }));
    const ctx: LeadCtx = {
      msgs, events: await db.all("SELECT type, at, confidence, detail FROM funnel_events WHERE lead_id = ? ORDER BY at", lid),
      visits: await db.all("SELECT * FROM visits WHERE lead_id = ? ORDER BY visited_at", lid),
      deal: await db.first("SELECT * FROM deals WHERE lead_id = ? ORDER BY id LIMIT 1", lid),
      roles: await db.all("SELECT role FROM lead_roles WHERE lead_id = ?", lid),
      listPrice: num(l["list_price"]), closedAt: l["closed_at"] ? Date.parse(String(l["closed_at"])) : Infinity, now,
      coverage: String(l["coverage"] ?? "full"),
    };
    const feats = extractFeatures(ctx);
    await db.run("DELETE FROM behaviors WHERE lead_id = ?", lid);
    await db.run("INSERT INTO behaviors (lead_id, staff_id, chat_staff_id, features, computed_at) VALUES (?,?,?,?,?)", lid, l["staff_id"] ?? null, chatStaffOf(msgs), JSON.stringify(feats), opts.now);
  }
  return { leads: leads.length };
}
