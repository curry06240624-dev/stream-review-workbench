/**
 * 漏斗事件引擎（決定性規則版）。
 *
 * 輸入：一個 lead 的對話、預約、到店、成交紀錄。
 * 輸出：帶證據、帶信心等級的事件。規則見 docs/FUNNEL_MODEL.md，改規則要同步改文件。
 *
 * 兩個原則：
 *   1. 結構化紀錄（預約表、成交表）優先，來源標 `ledger`；文字規則標 `rule`。
 *      真實資料沒有預約/成交表，所以文字規則不是備援，是主力 —— 它們的準確率用
 *      scripts/eval_funnel.mjs 對模擬器的標準答案量出來，沒過門檻不准上畫面。
 *   2. 沒有證據的事件不寫入。每個事件至少指到一則訊息（ledger 事件指到最接近的訊息）。
 */
import type { Confidence, EventSource, FunnelEventType } from "../model/types.ts";
import type { DbLike } from "../adapters/import.ts";

type Row = Record<string, unknown>;
interface Msg { id: number; role: string; text: string; at: number; type?: string; }
interface VehicleName { id: number; needles: string[]; }
interface Ctx {
  lead: Row; contact: Row; msgs: Msg[]; appts: Row[]; visits: Row[]; deals: Row[];
  /** 公司有接待群到店紀錄時，對話裡推測的到店一律「不確定」，不進轉換率 */
  hasReception?: boolean;
}
export interface Detected {
  type: FunnelEventType; at: number; confidence: Confidence; source: EventSource;
  detail: Record<string, unknown>; evidence: Array<{ message_id: number | null; note: string }>;
}

const H = 3_600_000, D = 24 * H;
export const RULES = {
  DROP_SILENCE_H: 72,      // 報價後沉默多久算流失
  INACTIVE_D: 7,           // 客戶沉默多久算不活躍
  FOLLOWUP_GAP_H: 24,      // 沉默多久後的業務主動訊息算「跟進」
  DISCUSSION_WINDOW_H: 48, // 有來有往的觀察窗
  LATENCY_MULT: 3,         // 報價後回覆變慢幾倍算 POSSIBLE 流失
  LOST_SILENCE_D: 21,      // 沒成交且客戶沉默多久 → 推定流失（POSSIBLE）
};

/* ── 語言規則（繁中、台灣車商語氣；改了要重跑 eval）── */
/* 2026-09-06 依浦森汽車真對話補：員工報價寫「開79.8」「月繳大概1萬多」「總價要到80多」「$298,000」；
   機器人車卡「2019年 MAZDA 3 開價$598,000」＋客戶按「我非常想立即知道這台車的資訊」才算報價；看車用「過來看」「給你地址」「現場」 */
const RE = {
  price:      /(?<![程跑清])(\d{1,3}(?:\.\d)?)\s*萬(?!\s*(?:公里|km))|開\s*\d{2,3}(?:\.\d)?(?!\d)|(?:月繳|月付|總價|報價|含過戶)\s*(?:大概|約|抓|款)?\s*[\d一二三四五六七八九十]|NT\$\s*\d|\$\s*\d{2,3},\d{3}|\d{2,3}多(?!少|久|台|人|次)/,   // 「月繳」「總價」要跟著數字才算報價（真資料：「預算或月繳款抓多少呢」不是報價）
  numWan:     /(\d{1,3}(?:\.\d)?)\s*萬|開\s*(\d{2,3}(?:\.\d)?)(?!\d)/,
  priceAsk:   /(?:萬|元|千)[^\d]{0,4}嗎|預算|接受嗎|抓多少|大概多少|是嗎/,   // 問預算的句子不是報價：「25萬內嗎」「月繳9000內都可以接受嗎」「貸款10萬左右這樣嗎」
  priceNot:   /結清|餘額|尾款/,   // 「結清大概 40 多萬」不是報價；里程用 price 裡的前後文擋（整句排除會把「189 萬 含過戶 里程 5 萬公里」也排掉）
  cardPrice:  /開價\s*\$?\s*([\d,]{5,9})/,
  cardClick:  /想立即知道|我要了解|我想了解/,
  objection:  /太貴|貴了|超出預算|太超出|沒那麼多|預算只有|(?:價格|價錢|總價|月繳|月付|報價|這樣|這個)\s*(?:有點|太)高|有點貴|不用這麼貴|(?:再|能不能|可以|可不可以|有沒有|算)(?:更|比較|再)?便宜|便宜(?:一點|一些|點|些)|(?<![\d.萬里程跑])\d{2,3}\s*萬?\s*以內的(?!\s*(?:里程|公里|km))|預算.{0,6}以內/,   // 「里程 10 萬以內的」「排氣量 2.0 以內」「這里程有點高」不是價格異議   // 「想買便宜的代步車」「最便宜多少」是需求不是異議，只認討價的講法
  counter:    /(?<![A-Za-z\d:：.\-/月])(\d{2,3})\s*萬?\s*(可以嗎|我就簽|成交|就訂)|含過戶\s*\d{2,3}|再少一點.*(馬上|就)訂|好啦.*\d+.*成交/,
  counterNot: /\d{1,2}[:：]\d{2}|\d+\s*點(?!\s*(?:多|萬))|(?<![\d,])\d{4,}\s*(?:可以嗎|好嗎)|貸|頭期|期數|約在|年式|那台|比\d|[A-Za-z]\d{2,3}|\d{2,3}\s*至\s*\d/,   // 「K14 可以嗎」「約在 7-11」「多貸 25 至 30」「2020 那台比 21」都不是出價   // 「16:30 可以嗎」是約時間、「5000 可以嗎」是訂金，不是出價
  financing:  /全額貸|利率|頭期|月付|月繳|自備款|自備|分期|信用|車貸|貸款.*(嗎|多少|怎麼|幾成|過)|貸款過嗎/,
  finOk:      /%|頭期\s*\d|月付大概|月繳大概|月繳.*\d|試算|貸款專員|沒問題|可以喔|利率|全額貸|一萬多|萬多|\d{4,5}\s*(?:左右|元|塊)|期的話/,
  finWeak:    /再問|再確認|問一下|應該可以|看個人條件/,   // resolved＝「有給具體答案」（教練用）；「沒人回」另外看 reply_message_id（需要注意清單用）
  apptProp:   /約個時間|來店|來看車|幫(?:你|您)留車|留車給|哪天有空|來看實車|過來看|現場看(?!過)|來現場|給你地址|載你|可以看車|方便(?:來|過來|到店)|(?:來|過來|到店|看車).{0,10}方便嗎/,   // 「收個 20000 方便嗎」「今天方便聯絡嗎」不是約看車，方便嗎要跟來／看車一起   // 「有空來看看嗎」是跟進不是約時間，不放「來看看」；「保留車款」含「留車」所以只認「幫你留車」
  apptTime:   /週[一二三四五六日]|禮拜|明天|後天|下午|早上|晚上|\d+\s*點/,
  apptConfirm:/見|留好|等您|收到|幫您留|等你/,
  cancel:     /取消|先不看/,
  noShow:     /臨時有事|忘記|抱歉.*改天|改天/,
  resched:    /改下週|改時間|改約.*(下週|時間)|改到|同一時間/,
  noShowStaff:/沒關係.*(改約|什麼時候)|留到週末|有空跟我說|那改約/,
  schedInText:/(\d{1,2})\/(\d{1,2})\s*(\d{1,2}):(\d{2})/,
  visitStaff: /今天.*(看的|看車|賞車)|謝謝您來|今天看的|今天來|剛剛來|來過了/,
  highIntent: /(?:很|蠻|滿|真的|超|有點|太)急|急(?:需|著|用|要|死|迫)|就想決定|要交車|沒問題就訂|老客戶|這週就|這個月要|有現車(就|我就)|定下來|跟你買過|買過.*想換|現金總價|月底前|這幾天要/,   // 光問「有現車嗎」不算急迫；「不急」「不著急」「不用急」不算（另見 highIntentNot）
  highIntentNot: /不著急|不用急|沒有很急|沒很急|沒那麼急|不是很急|不太急|沒有急|沒急|不急|別急|不趕|慢慢|應急|救急|緊急|急診|急救|急用金|要工作|要上班/,
  soldStaff:  /已交車|交車完成|交車愉快|恭喜(?:您|你)?(?:牽|交車|入手|買到|成交)|已經?過戶完成|過戶完成(?!後|前|就|才|再|是|幾|要)|(?:今天|昨天|剛剛)(?:順利)?交車(?!前)/,   // 只認過去式；「就可以交車了」「等交車了」「交車了嗎」全是未來式或問句   // 真資料的「交車」多半是「交車前會檢查」這種未來式，不算；「恭喜」單獨出現另外再擋（見 soldStaffNot）
  soldStaffNot: /交車前|到交車|交車流程|交車時|交車的|交車那|交車後|可以交車|就交車|才交車|等交車|交車了嗎|會交車|再交車|要交車|預計|希望|要先看|幾點|假如|月份|才交一|會很趕|原本|要先過戶|才過戶|恭喜(?:你|您)?(?:呀|啊)?[，,]?\s*(?:我|那|這|但)/,
  lostCust:   /跟朋友買|買了別家|先不換|預算不夠|不用了|之後再說|不好意思.*買了|已經買了|買好了/,
  laterPositiveCust: /成交|下訂|想看車|可以來看|我想看|過去看|考慮好了|過去看看/,
};

const isCounter = (t: string) => RE.counter.test(t) && !RE.counterNot.test(t);
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const ev = (type: FunnelEventType, at: number, confidence: Confidence, source: EventSource, detail: Record<string, unknown>, evidence: Detected["evidence"]): Detected => ({ type, at, confidence, source, detail, evidence });
const nearest = (msgs: Msg[], t: number): Msg | undefined => msgs.reduce<Msg | undefined>((best, m) => (!best || Math.abs(m.at - t) < Math.abs(best.at - t) ? m : best), undefined);

/** 純函式：一個 lead 的事件 */
export function detectEvents(ctx: Ctx, vehicles: VehicleName[], now: number): Detected[] {
  const out: Detected[] = [];
  const msgs = ctx.msgs;
  if (!msgs.length) return out;
  const custAll = msgs.filter((m) => m.role === "customer");
  const cust = custAll.filter((m) => m.type !== "menu");            // 客戶自己打的字；按選單的不算有來有往
  const staff = msgs.filter((m) => m.role === "staff");
  const bots = msgs.filter((m) => m.role === "bot");
  const first = msgs[0]!, last = msgs[msgs.length - 1]!;
  const outcome = String(ctx.lead["outcome"] ?? "");
  const displayName = String(ctx.contact["display_name"] ?? "");

  // NEW_LEAD（第一則客戶訊息，選單點擊也算進線）
  const firstCust = custAll[0] ?? first;
  out.push(ev("NEW_LEAD", firstCust.at, "CONFIRMED", "rule", {}, [{ message_id: firstCust.id, note: "第一則客戶訊息" }]));

  // VEHICLE_INTEREST：對話（含客戶按的車卡）提到車輛主檔裡的車款
  const vhit = msgs.find((m) => m.role !== "bot" && vehicles.some((v) => v.needles.some((n) => m.text.toLowerCase().includes(n))));
  if (vhit) {
    const v = vehicles.find((v) => v.needles.some((n) => vhit.text.toLowerCase().includes(n)))!;
    out.push(ev("VEHICLE_INTEREST", vhit.at, "CONFIRMED", "rule", { vehicle_id: v.id }, [{ message_id: vhit.id, note: "訊息提到車輛主檔裡的車款" }]));
  } else if (ctx.lead["vehicle_id"]) {
    out.push(ev("VEHICLE_INTEREST", first.at, "POSSIBLE", "rule", { vehicle_id: ctx.lead["vehicle_id"] }, [{ message_id: first.id, note: "只有 lead 綁了車，對話裡沒提到" }]));
  } else {
    const card = custAll.find((m) => RE.cardClick.test(m.text));   // 「我要了解 2019年 MAZDA 3」：車不在主檔也算有興趣
    if (card) out.push(ev("VEHICLE_INTEREST", card.at, "STRONGLY_SUGGESTED", "rule", { text: card.text.slice(0, 40) }, [{ message_id: card.id, note: "客戶按了車卡的「我要了解」" }]));
  }

  // ACTIVE_DISCUSSION
  const win = first.at + RULES.DISCUSSION_WINDOW_H * H;
  const c2 = cust.filter((m) => m.at <= win), s1 = staff.filter((m) => m.at <= win);
  if (c2.length >= 2 && s1.length >= 1) out.push(ev("ACTIVE_DISCUSSION", c2[1]!.at, "CONFIRMED", "rule", { customer_msgs_48h: c2.length }, [{ message_id: c2[1]!.id, note: "48 小時內客戶至少兩則、業務至少一則" }]));

  // HIGH_INTENT（前四則客戶訊息：需求描述常排第二則，急迫語排第三則）
  const hi = cust.slice(0, 4).find((m) => RE.highIntent.test(m.text) && !RE.highIntentNot.test(m.text));
  if (hi) out.push(ev("HIGH_INTENT", hi.at, "STRONGLY_SUGGESTED", "rule", { phrase: hi.text.match(RE.highIntent)?.[0] }, [{ message_id: hi.id, note: "客戶早期出現急迫用語" }]));

  // PRICE_MENTIONED：只認業務親自報的價。客戶按有開價的車卡不算報價（2026-09-07 瑋瑋看了說不準：7 天 261 次「報價」有 132 次是客戶自己點車卡，
  // 「價格後流失 44%」大半是點了車卡沒聊）；問預算的句子（25 萬內嗎／月繳 9000 內可以接受嗎）也不算
  const priceMsg = staff.find((m) => RE.price.test(m.text) && !RE.priceNot.test(m.text) && !RE.priceAsk.test(m.text));
  const priceNote = "業務報價"; const priceConf: Confidence = "CONFIRMED";
  let objectionMsg: Msg | undefined, negMsg: Msg | undefined;
  if (priceMsg) {
    const nm = priceMsg.text.match(RE.numWan);
    const wan = nm ? Number(nm[1] ?? nm[2]) || null : null;
    out.push(ev("PRICE_MENTIONED", priceMsg.at, priceConf, "rule", { price_wan: wan }, [{ message_id: priceMsg.id, note: priceNote }]));
    const custAfter = cust.filter((m) => m.at > priceMsg.at);
    objectionMsg = custAfter.find((m) => RE.objection.test(m.text) && !isCounter(m.text));
    if (objectionMsg) out.push(ev("PRICE_OBJECTION", objectionMsg.at, "CONFIRMED", "rule", {}, [{ message_id: priceMsg.id, note: "報價" }, { message_id: objectionMsg.id, note: "客戶對價格表達異議、沒有出價" }]));
    negMsg = custAfter.find((m) => isCounter(m.text));
    if (negMsg) out.push(ev("NEGOTIATION", negMsg.at, "CONFIRMED", "rule", { counter_wan: Number(negMsg.text.match(RE.numWan)?.[1] ?? 0) || null }, [{ message_id: negMsg.id, note: "客戶出價" }]));
  }

  // FINANCING_QUESTION（第一次）
  const fin = cust.find((m) => RE.financing.test(m.text));
  if (fin) {
    const reply = staff.find((m) => m.at > fin.at && m.at <= fin.at + 24 * H);
    const concrete = !!reply && /%|頭期\s*\d|月付大概\s*\d|試算/.test(reply.text);
    const resolved = !!reply && (concrete || (RE.finOk.test(reply.text) && !RE.finWeak.test(reply.text)));   // 「問一下貸款專員」不算有答
    out.push(ev("FINANCING_QUESTION", fin.at, "CONFIRMED", "rule", { resolved, reply_message_id: reply?.id ?? null }, [{ message_id: fin.id, note: "客戶問貸款/頭期/利率" }, ...(reply ? [{ message_id: reply.id, note: resolved ? "業務給了具體數字或轉專員" : "業務沒有給具體答案" }] : [])]));
  }

  // 預約：結構化紀錄優先
  let bookedAt: number | null = null;
  if (ctx.appts.length) {
    for (const a of ctx.appts) {
      const pAt = Date.parse(String(a["proposed_at"])), sAt = Date.parse(String(a["status_at"]));
      const near = nearest(msgs, pAt);
      out.push(ev("APPOINTMENT_PROPOSED", pAt, "CONFIRMED", "ledger", { appointment_id: a["id"] }, [{ message_id: near?.id ?? null, note: "預約紀錄" }]));
      const st = String(a["status"]);
      const nearS = nearest(msgs, sAt);
      if (st === "booked" || st === "completed") { out.push(ev("APPOINTMENT_BOOKED", sAt, "CONFIRMED", "ledger", { scheduled_for: a["scheduled_for"] }, [{ message_id: nearS?.id ?? null, note: "預約成立" }])); bookedAt = bookedAt ?? sAt; }
      if (st === "rescheduled") out.push(ev("APPOINTMENT_CHANGED", sAt, "CONFIRMED", "ledger", {}, [{ message_id: nearS?.id ?? null, note: "改期" }]));
      if (st === "cancelled") out.push(ev("APPOINTMENT_CANCELLED", sAt, "CONFIRMED", "ledger", {}, [{ message_id: nearS?.id ?? null, note: "取消" }]));
      if (st === "no_show") out.push(ev("NO_SHOW", sAt, "CONFIRMED", "ledger", {}, [{ message_id: nearS?.id ?? null, note: "爽約" }]));
    }
  } else {
    // 文字備援（真資料走這條）
    const prop = staff.find((m) => RE.apptProp.test(m.text));
    if (prop) {
      out.push(ev("APPOINTMENT_PROPOSED", prop.at, "CONFIRMED", "rule", {}, [{ message_id: prop.id, note: "業務提議看車時間" }]));
      const timeMsg = cust.filter((m) => m.at > prop.at).slice(0, 3).find((m) => RE.apptTime.test(m.text));
      const confirm = timeMsg && staff.find((m) => m.at > timeMsg.at && RE.apptConfirm.test(m.text));
      if (timeMsg && confirm) {
        bookedAt = confirm.at;
        out.push(ev("APPOINTMENT_BOOKED", confirm.at, "STRONGLY_SUGGESTED", "rule", {}, [{ message_id: timeMsg.id, note: "客戶給了時間" }, { message_id: confirm.id, note: "業務確認" }]));
        const after = cust.filter((m) => m.at > confirm.at);
        const cxl = after.find((m) => RE.cancel.test(m.text)); const ns = after.find((m) => RE.noShow.test(m.text)); const rs = after.find((m) => RE.resched.test(m.text));
        // 從確認訊息解出預約時間（「7/21 09:00 見」），台灣時間
        const sm = confirm.text.match(RE.schedInText);
        let sched: number | null = null;
        if (sm) { const y = new Date(confirm.at).getUTCFullYear(); sched = Date.parse(`${y}-${sm[1]!.padStart(2, "0")}-${sm[2]!.padStart(2, "0")}T${sm[3]!.padStart(2, "0")}:${sm[4]}:00+08:00`); if (sched < confirm.at) sched += 365 * D; }
        const visitSignal = staff.some((m) => m.at > confirm.at && RE.visitStaff.test(m.text));
        const staffAfterSched = sched ? staff.find((m) => m.at > sched! && RE.noShowStaff.test(m.text)) : undefined;
        if (cxl) out.push(ev("APPOINTMENT_CANCELLED", cxl.at, "STRONGLY_SUGGESTED", "rule", {}, [{ message_id: cxl.id, note: "客戶取消" }]));
        else if (rs) out.push(ev("APPOINTMENT_CHANGED", rs.at, "STRONGLY_SUGGESTED", "rule", {}, [{ message_id: rs.id, note: "客戶改期" }]));
        else if (ns) out.push(ev("NO_SHOW", ns.at, "STRONGLY_SUGGESTED", "rule", {}, [{ message_id: ns.id, note: "客戶事後說臨時有事/忘記" }]));
        else if (sched && !visitSignal && staffAfterSched) out.push(ev("NO_SHOW", staffAfterSched.at, "STRONGLY_SUGGESTED", "rule", { scheduled_for: new Date(sched).toISOString() }, [{ message_id: confirm.id, note: "預約時間" }, { message_id: staffAfterSched.id, note: "時間過了沒有到店訊號，業務改約" }]));
      }
    }
  }

  // 到店：接待群貼文（或其他到店表）優先；只有對話提到看車時，公司若有接待群紀錄就降為「不確定」
  if (ctx.visits.length) {
    for (const v of ctx.visits) {
      const vAt = Date.parse(String(v["visited_at"])); const src = String(v["source"] ?? "ledger");
      out.push(ev("STORE_VISIT", vAt, "CONFIRMED", "ledger", { outcome: v["outcome"], source: src, assigned_staff_id: v["staff_id"] ?? null }, [{ message_id: nearest(msgs, vAt)?.id ?? null, note: src === "reception" ? "接待群貼文" : "到店紀錄" }]));
    }
  } else if (bookedAt !== null) {
    const vs = staff.find((m) => m.at > bookedAt! && RE.visitStaff.test(m.text));
    if (vs) out.push(ev("STORE_VISIT", vs.at, ctx.hasReception ? "UNCLEAR" : "STRONGLY_SUGGESTED", "rule", { source: "chat" }, [{ message_id: vs.id, note: ctx.hasReception ? "只有對話提到看車，接待群沒有這位客戶的到店紀錄" : "預約後業務提到今天看車" }]));
  }

  // FOLLOW_UP：沉默 ≥24h 後業務主動
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i]!, prev = msgs[i - 1]!;
    if (m.role !== "staff") continue;
    const lastCust = [...cust].reverse().find((c) => c.at < m.at);
    const gap = m.at - prev.at;
    if (gap >= RULES.FOLLOWUP_GAP_H * H && (!lastCust || m.at - lastCust.at >= RULES.FOLLOWUP_GAP_H * H)) {
      out.push(ev("FOLLOW_UP", m.at, "CONFIRMED", "rule", { gap_hours: Math.round(gap / H) }, [{ message_id: m.id, note: `客戶沉默 ${Math.round(gap / H)} 小時後業務主動聯絡` }]));
    }
  }

  // 不活躍 / 回流：到店也算客戶的動作（剛來看過車的人不是「沉默」），沉默從客戶最後一則訊息或最後一次到店起算
  const visitTimes = ctx.visits.map((v) => Date.parse(String(v["visited_at"]))).filter((t) => Number.isFinite(t));
  const lastActivityBefore = (t: number, floor: number) => Math.max(floor, ...visitTimes.filter((v) => v > floor && v < t));
  for (let i = 1; i < cust.length; i++) {
    const since = lastActivityBefore(cust[i]!.at, cust[i - 1]!.at);
    const gap = cust[i]!.at - since;
    if (gap >= RULES.INACTIVE_D * D) {
      out.push(ev("CUSTOMER_INACTIVE", since + RULES.INACTIVE_D * D, "CONFIRMED", "rule", { silent_days: Math.round(gap / D) }, [{ message_id: cust[i - 1]!.id, note: since === cust[i - 1]!.at ? "此則之後客戶沉默超過 7 天" : "到店之後客戶沉默超過 7 天" }]));
      out.push(ev("RE_ENGAGED", cust[i]!.at, "CONFIRMED", "rule", { after_days: Math.round(gap / D) }, [{ message_id: cust[i]!.id, note: "沉默後客戶再度發訊" }]));
    }
  }
  const lastCust = cust[cust.length - 1];
  const saidLost = cust.some((m) => RE.lostCust.test(m.text));
  if (lastCust) {
    const since = lastActivityBefore(now, lastCust.at);
    if (now - since >= RULES.INACTIVE_D * D && outcome !== "sold" && !saidLost) {
      out.push(ev("CUSTOMER_INACTIVE", since + RULES.INACTIVE_D * D, "CONFIRMED", "rule", { silent_days: Math.round((now - since) / D) }, [{ message_id: lastCust.id, note: since === lastCust.at ? "最後一則客戶訊息，之後沉默超過 7 天" : "最後一次到店之後沉默超過 7 天" }]));
    }
  }

  // 成交/流失：帳本優先
  const soldDeal = ctx.deals.find((d) => d["status"] === "sold"), lostDeal = ctx.deals.find((d) => d["status"] === "lost");
  const soldTxt = staff.find((m) => RE.soldStaff.test(m.text) && !RE.soldStaffNot.test(m.text)), lostTxt = cust.find((m) => RE.lostCust.test(m.text));
  const markedSold = displayName.includes("已購車"), markedDead = displayName.includes("❌");
  if (soldDeal) {
    const gpKnown = String(soldDeal["cost_source"] ?? "ledger") !== "none";
    out.push(ev("SOLD", Date.parse(String(soldDeal["closed_at"])), "CONFIRMED", "ledger", { deal_id: soldDeal["id"], gross_profit: gpKnown ? soldDeal["gross_profit"] : null, gp_estimate: !!Number(soldDeal["gp_is_estimate"] ?? 0), source_kind: soldDeal["source_kind"] ?? "stock" }, [{ message_id: (soldTxt ?? last).id, note: soldDeal["report_id"] ? "成交群貼文（已配對）" : "成交帳本" }]));
  }
  else if (soldTxt) out.push(ev("SOLD", soldTxt.at, "STRONGLY_SUGGESTED", "rule", {}, [{ message_id: soldTxt.id, note: "業務說恭喜/過戶/交車" }]));
  else if (markedSold) out.push(ev("SOLD", last.at, "STRONGLY_SUGGESTED", "rule", { via: "display_name" }, [{ message_id: last.id, note: "顯示名稱標了「已購車」（公司自己的標記）" }]));
  if (lostDeal) out.push(ev("LOST", Date.parse(String(lostDeal["closed_at"])), "CONFIRMED", "ledger", { deal_id: lostDeal["id"], reason: lostDeal["lost_reason"] }, [{ message_id: (lostTxt ?? last).id, note: "流失帳本" }]));
  else if (lostTxt) out.push(ev("LOST", lostTxt.at, "STRONGLY_SUGGESTED", "rule", {}, [{ message_id: lostTxt.id, note: "客戶明說不買了" }]));
  else if (markedDead && !markedSold) out.push(ev("LOST", last.at, "STRONGLY_SUGGESTED", "rule", { via: "display_name" }, [{ message_id: last.id, note: "顯示名稱標了 ❌（公司自己標的無效客）" }]));
  else if (!soldDeal && !soldTxt && lastCust && now - lastCust.at >= RULES.LOST_SILENCE_D * D && !markedSold) {
    out.push(ev("LOST", lastCust.at + RULES.LOST_SILENCE_D * D, "POSSIBLE", "rule", { silent_days: Math.round((now - lastCust.at) / D), inferred: true }, [{ message_id: lastCust.id, note: `最後一則客戶訊息後沉默 ${Math.round((now - lastCust.at) / D)} 天且未成交，推定流失` }]));
  }

  // PRICE_DROP_OFF（最後算，因為要知道之後有沒有正向事件）
  if (priceMsg) {
    const laterPositive = out.some((e) => ["APPOINTMENT_BOOKED", "STORE_VISIT", "SOLD", "NEGOTIATION"].includes(e.type) && e.at > priceMsg.at)
      || cust.some((m) => m.at > priceMsg.at && RE.laterPositiveCust.test(m.text));
    if (!laterPositive) {
      const custAfter = cust.filter((m) => m.at > priceMsg.at);
      const evid: Detected["evidence"] = [{ message_id: priceMsg.id, note: "報價" }];
      let conf: Confidence | null = null; const detail: Record<string, unknown> = {};
      if (!custAfter.length) {
        const silentH = (now - priceMsg.at) / H; detail["silent_hours"] = Math.round(silentH); detail["pattern"] = "silent";
        conf = silentH >= RULES.DROP_SILENCE_H ? "CONFIRMED" : "UNCLEAR";
      } else if (objectionMsg) {
        const lastC = custAfter[custAfter.length - 1]!; const silentH = (now - lastC.at) / H;
        detail["pattern"] = "objection_then_silent"; detail["silent_hours"] = Math.round(silentH);
        evid.push({ message_id: objectionMsg.id, note: "異議" });
        conf = silentH >= RULES.DROP_SILENCE_H ? "STRONGLY_SUGGESTED" : "UNCLEAR";
      } else {
        // 回覆變慢？
        const before = cust.filter((m) => m.at < priceMsg.at);
        const lat: number[] = [];
        for (const c of before) { const s = [...staff].reverse().find((x) => x.at < c.at); if (s) lat.push(c.at - s.at); }
        const firstAfter = custAfter[0]!; const afterLat = firstAfter.at - priceMsg.at;
        if (lat.length >= 2 && afterLat >= RULES.LATENCY_MULT * median(lat)) {
          detail["pattern"] = "slower_reply"; detail["latency_mult"] = Math.round(afterLat / median(lat));
          evid.push({ message_id: firstAfter.id, note: `報價後回覆延遲是先前的 ${Math.round(afterLat / median(lat))} 倍` });
          conf = "POSSIBLE";
        }
      }
      if (conf) out.push(ev("PRICE_DROP_OFF", priceMsg.at, conf, "rule", detail, evid));
    }
  }
  return out;
}

/** 從事件推目前階段（衍生值） */
const STAGE_ORDER: Array<[FunnelEventType, string]> = [
  ["NEW_LEAD", "new"], ["VEHICLE_INTEREST", "interest"], ["ACTIVE_DISCUSSION", "discussion"], ["PRICE_MENTIONED", "price"],
  ["APPOINTMENT_BOOKED", "appointment"], ["STORE_VISIT", "visit"], ["NEGOTIATION", "negotiation"], ["SOLD", "closed"], ["LOST", "closed"],
];
export function stageOf(events: Detected[]): string {
  let stage = "new";
  for (const [t, s] of STAGE_ORDER) {
    // 「結案」只認確定或強烈建議的成交/流失；推定流失（沉默 21 天）的 lead 仍是開放的，不然會從待辦清單消失
    const closing = t === "SOLD" || t === "LOST";
    if (events.some((e) => e.type === t && e.confidence !== "UNCLEAR" && !(closing && (e.confidence === "POSSIBLE" || e.detail["inferred"])))) stage = s;
  }
  return stage;
}

/* ── 跑引擎並落庫（冪等：先清掉 rule/ledger 事件再重算；ai 事件保留）── */
export async function runFunnel(db: DbLike, opts: { now: string; leadIds?: number[] }): Promise<{ leads: number; events: number }> {
  const now = Date.parse(opts.now);
  const vehicles: VehicleName[] = (await db.all("SELECT id, brand, model FROM vehicles")).map((v) => ({
    id: Number(v["id"]), needles: [String(v["model"]).toLowerCase(), `${String(v["brand"])} ${String(v["model"])}`.toLowerCase()],
  }));
  const leadRows = opts.leadIds?.length
    ? await db.all(`SELECT l.*, c.display_name FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id IN (${opts.leadIds.map(() => "?").join(",")})`, ...opts.leadIds)
    : await db.all("SELECT l.*, c.display_name FROM leads l JOIN contacts c ON c.id = l.contact_id");
  const hasReception = !!(await db.first("SELECT 1 AS x FROM visits WHERE source = 'reception' LIMIT 1"));
  let total = 0;
  for (const lead of leadRows) {
    const lid = Number(lead["id"]);
    const msgs: Msg[] = (await db.all(
      `SELECT m.id, m.sender_role, m.text, m.created_at, m.msg_type FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.lead_id = ? ORDER BY m.created_at, m.id`, lid))
      .map((m) => ({ id: Number(m["id"]), role: String(m["sender_role"]), text: String(m["text"]), at: Date.parse(String(m["created_at"])), type: String(m["msg_type"] ?? "text") }));
    const ctx: Ctx = {
      lead, contact: { display_name: lead["display_name"] }, msgs,
      appts: await db.all("SELECT * FROM appointments WHERE lead_id = ? ORDER BY proposed_at", lid),
      visits: await db.all("SELECT * FROM visits WHERE lead_id = ? ORDER BY visited_at", lid),
      deals: await db.all("SELECT * FROM deals WHERE lead_id = ?", lid),
      hasReception,
    };
    const events = detectEvents(ctx, vehicles, now);
    await db.run("DELETE FROM evidence WHERE event_id IN (SELECT id FROM funnel_events WHERE lead_id = ? AND source IN ('rule','ledger'))", lid);
    await db.run("DELETE FROM funnel_events WHERE lead_id = ? AND source IN ('rule','ledger')", lid);
    const convRow = await db.first("SELECT id FROM conversations WHERE lead_id = ? ORDER BY id LIMIT 1", lid);
    for (const e of events) {
      const r = await db.run(
        `INSERT OR IGNORE INTO funnel_events (lead_id, conversation_id, contact_id, staff_id, vehicle_id, type, at, confidence, source, detail)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        lid, convRow ? Number(convRow["id"]) : null, Number(lead["contact_id"]), lead["staff_id"] ?? null,
        (e.detail["vehicle_id"] as number | undefined) ?? lead["vehicle_id"] ?? null,
        e.type, new Date(e.at).toISOString(), e.confidence, e.source, JSON.stringify(e.detail));
      if (r.lastRowId) for (const x of e.evidence) await db.run("INSERT INTO evidence (event_id, message_id, lead_id, note) VALUES (?,?,?,?)", r.lastRowId, x.message_id, lid, x.note);
      total++;
    }
    await db.run("UPDATE leads SET stage = ? WHERE id = ?", stageOf(events), lid);
  }
  return { leads: leadRows.length, events: total };
}
