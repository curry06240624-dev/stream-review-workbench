/**
 * SABC 客戶分級（公司訊息組的規則，見 docs/SABC_RULES.md）—— 系統推算版。
 *
 *   S：發生高推進動作（預約成立／到店事件、成交紀錄、對話裡出現 視訊／訂金／收訂／拉群／送貸／進件／對保／鎖車／過件／撥款）
 *   A：有真人對談 ＋ 車款已知 ＋ 客戶自己講過錢（預算／X 萬／月繳 X／頭期／X 萬以內）
 *   B：有真人對談，但車款或錢缺一
 *   C：沒有真人對談（只按選單、只有機器人、或客戶打了字沒人回）
 *   長週期（A／B 另加）：幾個月後／年底／過年後／明年／之後再說
 *   結果標籤：未過件、已送貸、純研究（跟分級分開）
 *
 * 寫進 leads.grade_auto／grade_reason／result_tag；訊息組在 Super 8 標的級在 contacts.grade，不互相覆蓋。
 * 分級是「現在推進到哪」，每次分析重算；判斷用的是客戶自己打的字（按選單、貼圖、照片不算）。
 */
import type { DbLike } from "../adapters/import.ts";
import { MENU_LIKE } from "../model/menu.ts";

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => String(v ?? "");

export type Grade = "S" | "A" | "B" | "C";

const RE = {
  money:      /(\d{1,3}(?:\.\d)?)\s*萬|預算.{0,8}\d|月繳\s*(?:大概|約|款)?\s*\d|月付\s*(?:大概|約)?\s*\d|頭期\s*\d|\d{1,3}\s*萬?\s*(?:以內|上下|左右|以下)|全額貸|一萬|兩萬|三萬|五千|六千|七千|八千|九千/,
  vehicle:    /[A-Za-z]{2,}\s*-?\d{0,4}|馬三|馬六|馬5|阿提斯|卡羅拉|仙草|皮卡|休旅|轎車|跑車|貨車|廂型|七人座|油電|柴油|國產|進口|雙B|賓士|寶馬|豐田|本田|日產|福特|馬自達|現代|三菱|鈴木|速霸陸|凌志|特斯拉/i,
  // 高推進動作要「已經發生」：客戶自己說做了，或員工確認收到／幫他做了。員工只是提議（可以視訊看車嗎、需要訂金喔）或講別台車（這台昨天收訂了）都不算
  custDone:   /我(?:先|已經|已|剛|等等|現在)?(?:付|匯|轉)(?:了)?訂|訂金(?:匯|付|轉)(?:了|好了|過去)|我(?:要|想|先)(?:下訂|訂了|付訂|付訂金|匯訂金)|已(?:匯|付)(?:了|款|訂)|匯過去了|下訂了|視訊(?:完|過|看過)|看過視訊|對保(?:完|好)|我(?:已經)?送件|資料(?:給|傳)(?:你|您)了|群組(?:加|進)了|我進群了/,
  staffDone:  /(?:已|已經|有)(?:收到|收)(?:你|您|妳)?(?:的)?訂金|訂金(?:收到|已收|有收到|收好)|(?:已|已經|有)幫(?:你|您|妳)(?:拉群|送件|進件|送貸|留車|鎖車|保留)|(?:拉群|進件|送件|送貸|對保)(?:了|完成|好了)(?!嗎)|過件了|恭喜過件|撥款|(?:已|已經)(?:拉|開)群|群組(?:拉|開)好了|幫(?:你|您)留(?:車|了)|已(?:留|鎖)車/,
  staffNot:   /這台.{0,10}(?:收訂|訂走|被訂|賣掉|售出)|才會退回|需要訂金|要訂金|會有訂金|訂金(?:是|多少|要)|可以視訊|視訊看車嗎|要不要視訊|想.{0,4}視訊|如果.{0,10}(?:進件|送件|拉群)|拉群.{0,4}嗎/,
  longCycle:  /(?:[一二兩三四五六幾]|\d+)\s*個月(?:後|以後)|年底|年後|過年後|明年|下半年|之後再說|等.{0,6}再說|還沒那麼快|先存錢|退伍|畢業後/,
  research:   /只是看看|先看看|隨便看看|研究一下|參考看看|問問而已|了解一下而已|還沒要買|沒有要買|觀望|純粹|沒打算/,
  loanNo:     /倒件|沒過件|不過件|退件|被拒|婉拒|沒過$|過不了/,
  loanSent:   /送貸|進件|送件|對保|已送|送銀行/,
};
const NOT_TYPED = new Set(["menu", "image", "video", "sticker", "audio", "file", "location"]);

export interface GradeOut { grade: Grade; reason: string; tags: string[] }

export function gradeOf(msgs: Array<{ role: string; type: string; text: string }>, events: string[], hasDeal: boolean, hasVehicle: boolean): GradeOut {
  const cust = msgs.filter((m) => m.role === "customer" && !NOT_TYPED.has(m.type) && !m.text.startsWith("[") && !MENU_LIKE.test(m.text));
  const staff = msgs.filter((m) => m.role === "staff");
  const custText = cust.map((m) => m.text).join("\n"), humanText = [...cust, ...staff].map((m) => m.text).join("\n");
  const human = cust.length >= 1 && staff.length >= 1;
  const tags: string[] = [];
  if (RE.loanNo.test(humanText)) tags.push("未過件");
  else if (RE.loanSent.test(humanText)) tags.push("已送貸");

  const sEvent = events.includes("APPOINTMENT_BOOKED") || events.includes("STORE_VISIT");
  const custHit = cust.map((m) => m.text).find((t) => RE.custDone.test(t));
  const staffHit = staff.map((m) => m.text).find((t) => RE.staffDone.test(t) && !RE.staffNot.test(t));
  if (hasDeal || sEvent || custHit || staffHit) {
    const why = hasDeal ? "有成交紀錄" : sEvent ? (events.includes("STORE_VISIT") ? "已到店" : "已約成看車") : custHit ? `客戶說已做（${custHit.match(RE.custDone)?.[0]}）` : `員工確認已做（${staffHit!.match(RE.staffDone)?.[0]}）`;
    return { grade: "S", reason: why, tags };
  }
  if (!human) {
    const why = !cust.length ? (msgs.some((m) => m.role === "customer") ? "只有按選單／貼圖，沒打過字" : "還沒有客戶訊息") : "客戶打了字，還沒有人回";
    if (cust.length && RE.research.test(custText)) tags.push("純研究");
    return { grade: "C", reason: why, tags };
  }
  const money = RE.money.test(custText), vehicle = hasVehicle || events.includes("VEHICLE_INTEREST") || RE.vehicle.test(custText);
  const longCycle = RE.longCycle.test(custText);
  if (longCycle) tags.push("長週期");
  if (vehicle && money) return { grade: "A", reason: `車款＋預算／月繳都講過${longCycle ? "，但說要晚點買" : ""}`, tags };
  if (!money && RE.research.test(custText)) tags.push("純研究");
  const missing = [!vehicle ? "車款" : "", !money ? "預算／月繳" : ""].filter(Boolean).join("、");
  return { grade: "B", reason: `有真人對談，還缺 ${missing}${longCycle ? "；說要晚點買" : ""}`, tags };
}

export async function computeGrades(db: DbLike, opts: { leadIds?: number[]; now: string }): Promise<{ leads: number; by_grade: Record<string, number> }> {
  const ids: number[] = opts.leadIds ?? (await db.all("SELECT id FROM leads ORDER BY id")).map((r) => num(r["id"]));
  const by: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 };
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90); const qs = chunk.map(() => "?").join(",");
    const leads = await db.all(`SELECT id, vehicle_id FROM leads WHERE id IN (${qs})`, ...chunk);
    const msgs = await db.all(`SELECT cv.lead_id, m.sender_role AS role, COALESCE(m.msg_type,'text') AS type, m.text FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.lead_id IN (${qs}) ORDER BY m.created_at, m.id`, ...chunk);
    const evs = await db.all(`SELECT lead_id, type FROM funnel_events WHERE confidence <> 'UNCLEAR' AND lead_id IN (${qs})`, ...chunk);
    const deals = await db.all(`SELECT lead_id FROM deals WHERE status = 'sold' AND lead_id IN (${qs})`, ...chunk);
    const mBy = new Map<number, Array<{ role: string; type: string; text: string }>>(), eBy = new Map<number, string[]>(), dSet = new Set(deals.map((d) => num(d["lead_id"])));
    for (const m of msgs) { const k = num(m["lead_id"]); if (!mBy.has(k)) mBy.set(k, []); mBy.get(k)!.push({ role: str(m["role"]), type: str(m["type"]), text: str(m["text"]) }); }
    for (const e of evs) { const k = num(e["lead_id"]); if (!eBy.has(k)) eBy.set(k, []); eBy.get(k)!.push(str(e["type"])); }
    for (const l of leads) {
      const id = num(l["id"]);
      const g = gradeOf(mBy.get(id) ?? [], eBy.get(id) ?? [], dSet.has(id), l["vehicle_id"] != null);
      by[g.grade] = (by[g.grade] ?? 0) + 1;
      await db.run("UPDATE leads SET grade_auto = ?, grade_reason = ?, result_tag = ? WHERE id = ?", g.grade, g.reason, g.tags.join("、"), id);
    }
  }
  return { leads: ids.length, by_grade: by };
}
