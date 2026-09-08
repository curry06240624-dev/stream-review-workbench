/**
 * 內部 LINE 群組貼文解析 —— 成交群「送貨囉」、估車群「估車」、接待群「客戶名／車款／到店時間／誰指派」，
 * 以及 LINE 聊天紀錄匯出檔（.txt）。全部是規則、可測（scripts/test_posts.ts）。
 *
 * 原則：寬鬆讀（全形冒號、缺欄、萬／元混用、「應該阿富」這種不確定寫法）、嚴格報（缺什麼一律列在 missing）。
 * 這裡只解析，不配對；配對在 reconcile.ts。
 */

export interface Fields { [label: string]: string }
export interface Post { at: string; sender: string; text: string }
export type Deposit = "cash" | "transfer" | "none" | "unknown" | "";
export type LoanStatus = "approved" | "rejected" | "none" | "pending" | "";   // pending＝送貸中（車源表 送貸）
/** 成交群貼文的標題：收訂囉／送貸囉／過件囉／售出囉（2026-09-08 真格式；「送貨囉」是 9/5 聽來的，實際沒有） */
export type DealStage = "deposit" | "loan_sent" | "loan_approved" | "delivered" | "";
export interface DealReportParsed {
  year: number | null; model_text: string; color: string; plate: string; plate_norm: string;
  deposit: Deposit; sale_price: number | null;
  source_kind: "stock" | "peer" | ""; peer_dealer: string;
  delivery_by: string; delivery_uncertain: boolean; note: string; loan_status: LoanStatus;
  customer_ref: string; staff_ref: string; missing: string[];
  stage: DealStage; loan_via: string;   // 標題階段；送貸單位（阿富／富哥／和潤／裕隆／現金…）
  plate_last4: string;                  // 只寫後四碼（「3600」）：不當完整車牌，配對時用尾碼找
  price_suspicious: boolean;            // 售價數字怪怪的（>500 萬或 <1 萬，例如 zinger 寫 95000萬）→ 不採用、列進 missing
}
export interface AppraisalParsed {
  model_text: string; year: number | null; trim: string; color: string; mileage_km: number | null;
  book_quanwei: number | null; book_tianshu: number | null; mode: "trade_in" | "sell" | ""; customer_ask: number | null; customer_ref: string;
}
export interface ReceptionParsed { customer_ref: string; model_text: string; visited_at: string | null; assigned_name: string; }

const TZ = 8 * 3_600_000;

/** 全形英數與標點 → 半形 */
export function toHalf(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, " ");
}
const clean = (s: string) => toHalf(s).replace(/[​-‍﻿]/g, "").trim();
/** 標籤正規化：去空白、去括號說明（「訂金（現金or匯款）」→「訂金」） */
const normLabel = (s: string) => clean(s).replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, "").replace(/[?？!！]/g, "");
/** 值裡的不確定寫法 */
export const RE_UNCERTAIN = /應該|大概|可能|好像|再確認|待確認|[?？]/;
/** 群組貼文的個資：電話與身分證字號在存進資料庫前抹掉（跟 LINE 對話匯入同一條規則） */
const RE_PHONE_G = /09\d{2}[- ]?\d{3}[- ]?\d{3}/g, RE_ID_G = /[A-Z][12]\d{8}/g;
export const scrubText = (s: string): string => s.replace(RE_PHONE_G, "[電話已抹掉]").replace(RE_ID_G, "[身分證字號已抹掉]");

/** 「標籤：值」逐行解析；同一標籤出現兩次取第一次 */
export function parseFields(text: string): Fields {
  const f: Fields = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = clean(raw); if (!line) continue;
    const m = line.match(/^([^:：]{1,16}?)\s*[:：]\s*(.*)$/); if (!m) continue;
    const k = normLabel(m[1]!); if (!k || k in f) continue;
    f[k] = (m[2] ?? "").trim();
  }
  return f;
}
const pickField = (f: Fields, labels: string[]): string | undefined => { for (const l of labels) if (l in f) return f[l]; return undefined; };

/** 金額：768000 / 76.8萬 / 76萬8 / 1,200,000 / 76萬。回傳元；解析不到回 null。小於 smallIsWan 的純數字視為「萬」（估車習慣寫 23、31）。 */
export function parseMoney(v: string | undefined, smallIsWan = 0): number | null {
  if (!v) return null;
  const s = clean(v).replace(/,/g, "").replace(/元|NT\$|nt\$|\$/gi, "").trim();
  const wan = s.match(/^(\d+(?:\.\d+)?)\s*[萬w]\s*(\d{1,2})?$/i);
  if (wan) { const base = Number(wan[1]); const rest = wan[2] ? Number(wan[2]) / Math.pow(10, wan[2].length) : 0; return Math.round((base + rest) * 10_000); }
  const n = s.match(/^(\d+(?:\.\d+)?)/); if (!n) return null;
  const x = Number(n[1]); if (!Number.isFinite(x)) return null;
  return smallIsWan && x < smallIsWan ? Math.round(x * 10_000) : Math.round(x);
}
export function parseYear(v: string | undefined): number | null {
  if (!v) return null; const s = clean(v);
  const m4 = s.match(/(20\d{2}|19\d{2})/); if (m4) return Number(m4[1]);
  const m2 = s.match(/^(\d{2})(?:年|式|$)/); if (m2) return 2000 + Number(m2[1]);
  return null;
}
/** 車牌正規化：去掉「-」與空白、全大寫；「無」「沒有」或太短視為空白 */
export function normalizePlate(v: string | undefined): string {
  if (!v) return ""; const s = clean(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^(無|沒有|N\/?A|X+)$/i.test(clean(v))) return "";
  return s.length >= 4 ? s : "";
}
export function parseDeposit(v: string | undefined): Deposit {
  if (v === undefined) return ""; const s = clean(v);
  if (!s) return "";
  if (/沒有|沒|無|不用|0/.test(s) && !/現金|匯款/.test(s)) return "none";
  if (/現金/.test(s)) return "cash";
  if (/匯款|轉帳|匯/.test(s)) return "transfer";
  return "unknown";
}
export function parseLoan(text: string): LoanStatus {
  if (/倒件|拒件|沒過|退件|不過/.test(text)) return "rejected";
  if (/過件/.test(text)) return "approved";
  if (/不用貸|無貸|不貸|全額現金/.test(text)) return "none";
  return "";
}
/** 顏色縮成一個字（珍珠白／白色／白 → 白），配對用 */
export const colorKey = (s: string) => { const m = clean(s).match(/[白黑銀灰紅藍綠棕金橘黃紫米咖]/); return m ? m[0] : clean(s).slice(0, 2).toLowerCase(); };

/** 車型別名：口語 → 主檔寫法（小寫、去空白）。配對時兩邊都先過這張表。 */
const MODEL_ALIAS: Array<[RegExp, string]> = [
  [/^馬三$|^馬3$|^mazda3$|^m3$/i, "mazda3"], [/^馬六$|^馬6$|^mazda6$/i, "mazda6"], [/^馬五$|^馬5$/i, "mazda5"],
  [/^cx[- ]?5$/i, "cx-5"], [/^cx[- ]?3$/i, "cx-3"], [/^cx[- ]?30$/i, "cx-30"],
  [/^阿提斯$|^altis$|^corollaaltis$/i, "altis"], [/^小鴨$|^yaris$/i, "yaris"], [/^cross$|^corollacross$|^cc$/i, "corollacross"],
  [/^c[- ]?300$/i, "c300"], [/^c[- ]?200$/i, "c200"], [/^c[- ]?250$/i, "c250"], [/^e[- ]?200$/i, "e200"], [/^e[- ]?300$/i, "e300"],
  [/^glc[- ]?200$/i, "glc200"], [/^glc[- ]?300$/i, "glc300"], [/^gla[- ]?200$/i, "gla200"],
  [/^318[i]?$/i, "318i"], [/^320[i]?$/i, "320i"], [/^330[i]?$/i, "330i"], [/^520[i]?$/i, "520i"], [/^x[- ]?1$/i, "x1"], [/^x[- ]?3$/i, "x3"],
  [/^nx[- ]?200$/i, "nx200"], [/^es[- ]?200$/i, "es200"], [/^rx[- ]?300$/i, "rx300"],
  [/^crv$|^cr-v$/i, "cr-v"], [/^hrv$|^hr-v$/i, "hr-v"], [/^focus$|^佛克斯$/i, "focus"], [/^kuga$/i, "kuga"], [/^tucson$|^tucsonl$/i, "tucsonl"],
];
export function modelKey(s: string): string {
  const k = clean(s).toLowerCase().replace(/\s+/g, "").replace(/(\d{4})年?/, "").trim();
  for (const [re, to] of MODEL_ALIAS) if (re.test(k)) return to;
  return k;
}
/** 兩個車型字串像不像：別名後相等，或一方含另一方（至少 3 字） */
export function modelLike(a: string, b: string): boolean {
  const x = modelKey(a), y = modelKey(b); if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.replace(/-/g, ""), ys = y.replace(/-/g, "");
  return (xs.length >= 3 && ys.includes(xs)) || (ys.length >= 3 && xs.includes(ys));
}

/* ── 成交群「送貨囉」 ── */
export const RE_DEAL = /送貨|售價|成交價|同行\s*\/\s*庫存|送貨單位|交車囉/;
export function parseDealReport(text: string): DealReportParsed | null {
  const t = clean(text); if (!RE_DEAL.test(t)) return null;
  const f = parseFields(t);
  const year = parseYear(pickField(f, ["年份", "年式", "年", "出廠"]));
  const model_text = (pickField(f, ["車型", "車款", "車種", "車輛"]) ?? "").trim();
  const color = (pickField(f, ["顏色", "車色"]) ?? "").trim();
  const plateRaw = pickField(f, ["車號", "車牌", "車牌號碼", "牌照"]) ?? "";
  const unknownPlate = /不知道|未知|不清楚|待補|沒有|還沒|再補/.test(clean(plateRaw));
  const plate = unknownPlate ? "" : clean(plateRaw); let plate_norm = unknownPlate ? "" : normalizePlate(plateRaw), plate_last4 = "";
  if (/^\d{4}$/.test(plate_norm)) { plate_last4 = plate_norm; plate_norm = ""; }   // 只寫後四碼
  const deposit = parseDeposit(pickField(f, ["訂金", "定金", "訂金方式"]));
  let sale_price = parseMoney(pickField(f, ["售價", "成交價", "賣價", "價格", "總價"]), 1000); let price_suspicious = false;
  if (sale_price != null && (sale_price > 5_000_000 || (sale_price > 0 && sale_price < 10_000))) { price_suspicious = true; sale_price = null; }
  const srcRaw = pickField(f, ["同行/庫存", "同行／庫存", "庫存/同行", "同行或庫存", "車源", "同行", "庫存"]) ?? "";
  let source_kind: DealReportParsed["source_kind"] = "", peer_dealer = "";
  if (srcRaw) {
    if (/庫存|自有|本店|自己|in\s*stock/i.test(srcRaw)) source_kind = "stock";
    else { source_kind = "peer"; peer_dealer = clean(srcRaw).replace(/^同行\s*[:：]?\s*/, "").trim(); }
  }
  const delRaw = pickField(f, ["送貨單位", "送貨", "交車人", "交車單位", "送車"]) ?? "";
  const delivery_uncertain = RE_UNCERTAIN.test(delRaw);
  const delivery_by = clean(delRaw).replace(/應該|大概|可能|好像|是|再確認|待確認|[?？]/g, "").trim();
  const note = (pickField(f, ["備註", "備注", "註", "說明"]) ?? "").trim();
  const loanField = pickField(f, ["貸款", "貸款結果", "對保"]) ?? "";
  const head = clean(text.split(/\r?\n/)[0] ?? "");
  const stage: DealStage = /售出/.test(head) ? "delivered" : /過件/.test(head) ? "loan_approved" : /送貸/.test(head) ? "loan_sent" : /收訂|訂金/.test(head) ? "deposit" : "";
  const loan_via = clean(pickField(f, ["送貸單位", "送貸", "貸款單位", "財務公司", "貸款公司"]) ?? "");
  let loan_status = parseLoan(`${note} ${loanField}`);
  if (!loan_status) {
    if (stage === "loan_approved") loan_status = "approved";
    else if (/現金/.test(loan_via) || /現金/.test(note)) loan_status = "none";
    else if (stage === "loan_sent" || (loan_via && !/同行盤售|盤售/.test(loan_via))) loan_status = "pending";
  }
  const customer_ref = (pickField(f, ["客戶", "客人", "客戶名", "客戶名稱", "買家", "車主"]) ?? "").trim();
  const staff_ref = (pickField(f, ["業務", "銷售", "成交業務", "負責業務", "經手"]) ?? "").trim();
  const missing: string[] = [];
  if (!plate_norm) missing.push("車號");
  if (sale_price == null) missing.push(price_suspicious ? "售價（數字怪怪的）" : "售價");
  if (!customer_ref) missing.push("客戶");
  if (!staff_ref) missing.push("業務");
  if (year == null && !model_text) missing.push("年份或車型");
  return { year, model_text, color, plate, plate_norm, deposit, sale_price, source_kind, peer_dealer, delivery_by, delivery_uncertain, note, loan_status, customer_ref, staff_ref, missing, stage, loan_via, plate_last4, price_suspicious };
}

/* ── 估車群 ── */
export const RE_APPRAISAL = /估車|權威|天書/;
export function parseAppraisal(text: string): AppraisalParsed | null {
  const t = clean(text); if (!RE_APPRAISAL.test(t)) return null;
  const f = parseFields(t);
  const mileRaw = pickField(f, ["里程", "公里", "里程數"]);
  let mileage_km: number | null = null;
  if (mileRaw) { const m = parseMoney(mileRaw.replace(/km|公里|k$/i, ""), 0); if (m != null) mileage_km = m < 100 ? m * 10_000 : m; }
  const modeRaw = pickField(f, ["車換車or純賣", "車換車or純售", "交易方式", "車換車", "純賣", "換車"]) ?? "";
  const mode: AppraisalParsed["mode"] = /換車|換/.test(modeRaw) ? "trade_in" : /純賣|純售|賣|售/.test(modeRaw) ? "sell" : "";
  return {
    model_text: (pickField(f, ["車型", "車款", "車種"]) ?? "").trim(), year: parseYear(pickField(f, ["年份", "年式", "年"])),
    trim: (pickField(f, ["版本", "等級", "車型等級"]) ?? "").trim(), color: (pickField(f, ["顏色", "車色"]) ?? "").trim(), mileage_km,
    book_quanwei: parseMoney(pickField(f, ["權威", "權威車訊", "權威價"]), 1000), book_tianshu: parseMoney(pickField(f, ["天書", "天書價"]), 1000),
    mode, customer_ask: parseMoney(pickField(f, ["客人理想價格", "理想價格", "客人期望", "期望價格", "客人想要"]), 1000),
    customer_ref: (pickField(f, ["客戶", "客人", "客戶名", "車主"]) ?? "").trim(),
  };
}

/* ── 接待群 ── */
export const RE_RECEPTION = /到店時間|誰指派|指派|接待/;
/** 時間解析：「14:30」「9/5 14:30」「下午3點」「明天 15:00」，以貼文時間（台灣時區）為基準；解析不到回 null */
export function parseTimeNear(v: string, baseIso: string): string | null {
  const s = clean(v).replace(/\s+/g, " "); if (!s) return null;
  const base = new Date(Date.parse(baseIso) + TZ);
  let y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, d = base.getUTCDate();
  const md = s.match(/(\d{1,2})\s*[\/／.月]\s*(\d{1,2})/); if (md) { mo = Number(md[1]); d = Number(md[2]); }
  if (/明天/.test(s)) { const t = new Date(Date.UTC(y, mo - 1, d + 1)); y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate(); }
  if (/後天/.test(s)) { const t = new Date(Date.UTC(y, mo - 1, d + 2)); y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate(); }
  const hm = s.match(/(\d{1,2})\s*[:：點]\s*(\d{2})?/); if (!hm) return null;
  let hh = Number(hm[1]); const mm = hm[2] ? Number(hm[2]) : 0;
  if (/下午|晚上|傍晚/.test(s) && hh < 12) hh += 12;
  if (hh > 23 || mm > 59) return null;
  const local = Date.UTC(y, mo - 1, d, hh, mm);
  return new Date(local - TZ).toISOString();
}
export function parseReception(text: string, postAt: string): ReceptionParsed | null {
  const t = clean(text);
  const f = parseFields(t);
  const customer = pickField(f, ["客戶名", "客戶", "客人", "姓名", "客戶名稱"]);
  const model = pickField(f, ["車款", "車型", "車種"]);
  const when = pickField(f, ["到店時間", "時間", "到店", "來店時間"]);
  const who = pickField(f, ["誰指派", "指派", "業務", "接待", "接待業務", "指派業務"]);
  if (customer !== undefined || when !== undefined || who !== undefined) {
    if (!customer && !model) return null;
    return { customer_ref: (customer ?? "").trim(), model_text: (model ?? "").trim(), visited_at: when ? parseTimeNear(when, postAt) : null, assigned_name: (who ?? "").replace(/指派|→|->/g, "").trim() };
  }
  // 沒有標籤：「客戶名 車款 到店時間 誰指派」用空白分開
  if (!RE_RECEPTION.test(t) && !/\d{1,2}[:：]\d{2}/.test(t)) return null;
  const tokens = t.replace(/接待[:：]?/, "").split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;
  const ti = tokens.findIndex((x) => /\d{1,2}[:：]\d{2}|點/.test(x));
  if (ti < 1) return null;
  const timeTok = /^(今天|明天|後天|下午|早上|晚上)$/.test(tokens[ti - 1] ?? "") ? `${tokens[ti - 1]} ${tokens[ti]}` : tokens[ti]!;
  const head = tokens.slice(0, /^(今天|明天|後天|下午|早上|晚上)$/.test(tokens[ti - 1] ?? "") ? ti - 1 : ti);
  const tail = tokens.slice(ti + 1);
  return { customer_ref: head[0] ?? "", model_text: head.slice(1).join(" "), visited_at: parseTimeNear(timeTok, postAt), assigned_name: tail.join("").replace(/指派|→|->/g, "").trim() };
}

/* ── 類型判斷 ── */
export function detectKind(text: string): "deal" | "appraisal" | "reception" | "unknown" {
  const t = clean(text);
  if (RE_DEAL.test(t) && parseFields(t)["售價"] !== undefined || /送貨囉|送貨/.test(t)) return "deal";
  if (/估車/.test(t) || (/權威/.test(t) && /天書/.test(t))) return "appraisal";
  if (/到店時間|誰指派/.test(t) || (parseFields(t)["客戶名"] !== undefined && parseFields(t)["車款"] !== undefined)) return "reception";
  if (RE_DEAL.test(t)) return "deal";
  return "unknown";
}

/* ── LINE 聊天紀錄匯出檔 ── */
const RE_DATE = /^(\d{4})[./\-年](\d{1,2})[./\-月](\d{1,2})/;
const RE_MSG_TAB = /^(\d{1,2}):(\d{2})\t([^\t]*)\t([\s\S]*)$/;
const RE_MSG_SP = /^(\d{1,2}):(\d{2})\s+(\S+)\s+([\s\S]*)$/;
const RE_SYSTEM = /已收回訊息|已新增.*至群組|加入了群組|退出了群組|已將.*移出|已建立群組|通話時間|未接來電|語音通話|視訊通話/;
/** 回傳依時間排序的貼文；同一則多行會合併；系統訊息略過。at 用台灣時區。 */
export function parseLineExport(txt: string): Post[] {
  const out: Post[] = [];
  let y = 0, mo = 0, d = 0; let cur: Post | null = null;
  const flush = () => { if (cur && cur.text.trim() && !RE_SYSTEM.test(cur.text)) out.push({ ...cur, text: cur.text.trim() }); cur = null; };
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/﻿/g, "");
    const dm = line.trim().match(RE_DATE);
    if (dm && line.trim().length <= 24) { flush(); y = Number(dm[1]); mo = Number(dm[2]); d = Number(dm[3]); continue; }
    const mm = line.match(RE_MSG_TAB) ?? line.match(RE_MSG_SP);
    if (mm && y) {
      flush();
      const at = new Date(Date.UTC(y, mo - 1, d, Number(mm[1]), Number(mm[2])) - TZ).toISOString();
      cur = { at, sender: clean(mm[3] ?? ""), text: (mm[4] ?? "").replace(/^"|"$/g, "") };
      continue;
    }
    if (cur) cur.text += "\n" + line.replace(/^"|"$/g, "");
  }
  flush();
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** 貼文的穩定外部鍵（FNV-1a）：同一則重匯不會重複 */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let g = 0x811c9dc5 ^ s.length;
  for (let i = s.length - 1; i >= 0; i--) { g ^= s.charCodeAt(i); g = Math.imul(g, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0") + g.toString(16).padStart(8, "0");
}
