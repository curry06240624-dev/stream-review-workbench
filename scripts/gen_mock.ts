/**
 * 寫實模擬資料產生器 —— 台灣中古車商的 LINE 銷售對話。
 *
 * 目標不是「有資料」，是「像到 AI 分析抓得出模式」：
 *   - 38 種劇本（價格後流失、預約爽約、到店未買、高毛利、弱跟進、主管介入、同事支援、交接、回流、九種流失原因……）
 *   - 每位業務有自己的「風格」（報價後會不會問問題、異議後會不會釐清、高意圖時會不會約看車、貸款答不答得具體、到店後多快跟進）
 *     → 這些風格會影響結果，員工效能模組才量得出「表現好的人做了什麼不一樣」
 *   - 語氣照真實觀察（「!!」結尾、兄弟、預算、貸款、頭期、過戶、賞車）
 *   - 時間照真實節奏（晚上尖峰、業務隔夜才回、客人冷熱不同）
 *   - 顯示名稱照公司的習慣塞日期與「已購車」，adapter 之後要能解析同樣的東西
 *
 * 決定論：同一個 seed 每次產一樣的資料，測試才可重現。
 * 另外輸出 truth.json —— 每個 lead 的劇本、該被偵測到的事件、流失原因、角色、行為特徵，用來量準確率。
 *
 * 用法：node scripts/gen_mock.ts [seed]  →  data/mock/bundle.json, data/mock/truth.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import type {
  BundleAppointment, BundleAssignment, BundleConversation, BundleCustomer, BundleDeal, BundleLead,
  BundleMessage, BundleStaff, BundleVehicle, BundleVisit, NormalizedBundle, TruthLabel,
} from "../src/model/bundle.ts";
import type { LeadSource, LostReason } from "../src/model/types.ts";

/* ── 亂數（可重現）─────────────────────────────────────── */
let seed = Number(process.argv[2] || 20260904) >>> 0;
const rnd = () => { seed += 0x6D2B79F5; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const chance = (p: number) => rnd() < p;

/* ── 時間 ─────────────────────────────────────────────── */
const MIN = 60_000, H = 60 * MIN, D = 24 * H, TZ = 8 * H;
const NOW = Date.parse("2026-09-04T12:00:00Z");
const SPAN_DAYS = 70;                                           // 十週歷史，才有「上週 vs 本週」
const iso = (t: number) => new Date(t).toISOString();
const localHour = (t: number) => new Date(t + TZ).getUTCHours();
const localDow = (t: number) => new Date(t + TZ).getUTCDay();   // 0=日
/** 真實熱圖：晚上尖峰、週二週四略高 */
const HOUR_W = [1,1,0,0,0,0,1,2,4,7,11,10, 8,7,6,6,7,9, 12,16,18,15, 9,4];
const DOW_W = [7, 8, 11, 8, 11, 9, 7];
function weightedHour(): number {
  const tot = HOUR_W.reduce((a, b) => a + b, 0); let r = rnd() * tot;
  for (let h = 0; h < 24; h++) { r -= HOUR_W[h]!; if (r <= 0) return h; } return 20;
}
function leadStart(): number {
  for (let tries = 0; tries < 50; tries++) {
    const day = NOW - int(2, SPAN_DAYS) * D;
    if (rnd() * 11 <= DOW_W[localDow(day)]!) {
      const base = day - ((day + TZ) % D);                       // 當天台灣 00:00
      return base + weightedHour() * H + int(0, 59) * MIN;
    }
  }
  return NOW - 30 * D;
}
/** 半夜不回訊息：落在 01:00–08:00 就推到早上 */
function daylight(t: number): number {
  const h = localHour(t);
  if (h >= 1 && h < 8) return t + (8 - h) * H + int(10, 210) * MIN;
  return t;
}

/* ── 人 ───────────────────────────────────────────────── */
/** 風格＝行為機率。這些不是「好壞標籤」，是模擬器讓結果跟行為有關聯的機制；引擎要自己從對話量出來。 */
interface Style {
  askAfterPrice: number;        // 報價後接一個診斷式問題
  objectionClarify: number;     // 客戶說太貴後先問清楚（預算／總價或月付）
  proposeAfterIntent: number;   // 客戶表達急迫後主動約看車
  finAnswer: number;            // 貸款問題給具體數字
  postVisitH: [number, number]; // 到店後多少小時內跟進
  clarifyBudget: number;        // 開場就問預算
}
interface Profile { name: string; team: string; reply: [number, number]; followup: number; style: Style; }
/** reply＝回覆延遲分鐘區間；followup＝跟進品質 0–1（弱跟進劇本靠它） */
const AGENTS: Profile[] = [
  { name: "小婷", team: "業務一組", reply: [3, 20],   followup: 0.9,  style: { askAfterPrice: 0.75, objectionClarify: 0.7,  proposeAfterIntent: 0.8,  finAnswer: 0.85, postVisitH: [1, 6],   clarifyBudget: 0.7 } },
  { name: "阿凱", team: "業務一組", reply: [40, 480], followup: 0.35, style: { askAfterPrice: 0.2,  objectionClarify: 0.2,  proposeAfterIntent: 0.25, finAnswer: 0.4,  postVisitH: [12, 48], clarifyBudget: 0.2 } },
  { name: "小柔", team: "業務一組", reply: [10, 60],  followup: 0.8,  style: { askAfterPrice: 0.7,  objectionClarify: 0.6,  proposeAfterIntent: 0.7,  finAnswer: 0.8,  postVisitH: [2, 8],   clarifyBudget: 0.6 } },
  { name: "阿豪", team: "業務一組", reply: [5, 30],   followup: 0.6,  style: { askAfterPrice: 0.5,  objectionClarify: 0.45, proposeAfterIntent: 0.5,  finAnswer: 0.6,  postVisitH: [4, 16],  clarifyBudget: 0.4 } },
  { name: "大偉", team: "業務二組", reply: [5, 25],   followup: 0.4,  style: { askAfterPrice: 0.35, objectionClarify: 0.3,  proposeAfterIntent: 0.4,  finAnswer: 0.5,  postVisitH: [6, 24],  clarifyBudget: 0.3 } },
  { name: "佳佳", team: "業務二組", reply: [15, 90],  followup: 0.85, style: { askAfterPrice: 0.6,  objectionClarify: 0.55, proposeAfterIntent: 0.6,  finAnswer: 0.7,  postVisitH: [3, 12],  clarifyBudget: 0.5 } },
  { name: "阿國", team: "業務二組", reply: [60, 600], followup: 0.3,  style: { askAfterPrice: 0.15, objectionClarify: 0.15, proposeAfterIntent: 0.2,  finAnswer: 0.3,  postVisitH: [24, 72], clarifyBudget: 0.15 } },
  { name: "妮妮", team: "業務二組", reply: [3, 15],   followup: 0.9,  style: { askAfterPrice: 0.8,  objectionClarify: 0.75, proposeAfterIntent: 0.85, finAnswer: 0.9,  postVisitH: [1, 4],   clarifyBudget: 0.8 } },
];
const MANAGER = "阿哲";
const STAFF: BundleStaff[] = [
  { name: "老闆", role: "admin", team: "管理", email: "boss@test.local" },
  { name: MANAGER, role: "operator", team: "管理", email: "operator@test.local" },
  ...AGENTS.map((a, i) => ({ name: a.name, role: "agent" as const, team: a.team, email: `agent${i + 1}@test.local` })),
];

const SURNAME = "陳林黃張李王吳劉蔡楊許鄭謝洪郭曾廖賴徐周葉蘇莊呂江何蕭羅高".split("");
const GIVEN = ["家豪","志明","淑芬","雅婷","俊傑","佩珊","建宏","怡君","柏翰","宗翰","詩涵","冠宇","欣怡","承翰","子軒","品妤","宥廷","羽彤"];
const TITLE = ["先生", "小姐", "大哥", "姊", ""];

/* ── 車 ───────────────────────────────────────────────── */
interface CarSpec { brand: string; model: string; year: number; body: string; price: number; costRatio: number; tag?: string; }
const CAR_SPECS: CarSpec[] = [
  { brand: "Toyota", model: "Altis",         year: 2020, body: "sedan", price: 52,  costRatio: 0.88 },
  { brand: "Toyota", model: "RAV4",          year: 2021, body: "suv",   price: 92,  costRatio: 0.90 },
  { brand: "Toyota", model: "Corolla Cross", year: 2022, body: "suv",   price: 78,  costRatio: 0.89 },
  { brand: "Toyota", model: "Sienta",        year: 2019, body: "mpv",   price: 52,  costRatio: 0.84, tag: "quiet_high" },
  { brand: "Toyota", model: "Yaris",         year: 2019, body: "hatch", price: 38,  costRatio: 0.87 },
  { brand: "Honda",  model: "Fit",           year: 2021, body: "hatch", price: 55,  costRatio: 0.89 },
  { brand: "Honda",  model: "CR-V",          year: 2020, body: "suv",   price: 88,  costRatio: 0.91 },
  { brand: "Honda",  model: "HR-V",          year: 2022, body: "suv",   price: 76,  costRatio: 0.90 },
  { brand: "Mazda",  model: "Mazda3",        year: 2021, body: "sedan", price: 68,  costRatio: 0.88 },
  { brand: "Mazda",  model: "CX-5",          year: 2020, body: "suv",   price: 85,  costRatio: 0.90 },
  { brand: "Nissan", model: "Kicks",         year: 2020, body: "suv",   price: 58,  costRatio: 0.83, tag: "quiet_high" },
  { brand: "Nissan", model: "Sentra",        year: 2021, body: "sedan", price: 56,  costRatio: 0.88 },
  { brand: "Lexus",  model: "NX200",         year: 2021, body: "suv",   price: 168, costRatio: 0.93, tag: "hot_low" },
  { brand: "Lexus",  model: "ES200",         year: 2020, body: "sedan", price: 128, costRatio: 0.92 },
  { brand: "Mercedes-Benz", model: "GLC200", year: 2020, body: "suv",   price: 189, costRatio: 0.94, tag: "hot_low" },
  { brand: "Mercedes-Benz", model: "C200",   year: 2019, body: "sedan", price: 118, costRatio: 0.92 },
  { brand: "BMW",    model: "320i",          year: 2020, body: "sedan", price: 132, costRatio: 0.92 },
  { brand: "BMW",    model: "X3",            year: 2019, body: "suv",   price: 145, costRatio: 0.93 },
  { brand: "Volkswagen", model: "Tiguan",    year: 2020, body: "suv",   price: 82,  costRatio: 0.90 },
  { brand: "Volkswagen", model: "Golf",      year: 2021, body: "hatch", price: 74,  costRatio: 0.89 },
  { brand: "Ford",   model: "Kuga",          year: 2021, body: "suv",   price: 79,  costRatio: 0.89 },
  { brand: "Ford",   model: "Focus",         year: 2020, body: "hatch", price: 56,  costRatio: 0.87 },
  { brand: "Hyundai", model: "Tucson L",     year: 2022, body: "suv",   price: 88,  costRatio: 0.90 },
  { brand: "Mitsubishi", model: "Outlander", year: 2019, body: "suv",   price: 62,  costRatio: 0.86 },
  { brand: "Suzuki", model: "Swift",         year: 2021, body: "hatch", price: 48,  costRatio: 0.86 },
  { brand: "Subaru", model: "Forester",      year: 2020, body: "suv",   price: 89,  costRatio: 0.91 },
  { brand: "Kia",    model: "Sportage",      year: 2021, body: "suv",   price: 84,  costRatio: 0.90 },
  { brand: "Luxgen", model: "URX",           year: 2020, body: "suv",   price: 55,  costRatio: 0.80 },
];
const VEHICLES: BundleVehicle[] = CAR_SPECS.map((c, i) => ({
  key: `V${i + 1}`, brand: c.brand, model: c.model, year: c.year, body_type: c.body,
  list_price: c.price * 10_000, cost: Math.round(c.price * 10_000 * c.costRatio),
  stock_status: "in_stock",
}));
const carByTag = (tag: string) => { const idx = CAR_SPECS.map((c, i) => c.tag === tag ? i : -1).filter((i) => i >= 0); return VEHICLES[pick(idx)]!; };
const anyCar = () => pick(VEHICLES);
const carName = (v: BundleVehicle) => `${v.year} ${v.brand} ${v.model}`;
const wan = (n: number) => Math.round(n / 10_000);

/* ── 對話產生：一個會走時間的「場景」 ─────────────────── */
interface Scene {
  t: number; agent: Profile; car: BundleVehicle; cust: BundleCustomer;
  msgs: BundleMessage[]; appts: BundleAppointment[]; visits: BundleVisit[];
  leadKey: string; convKey: string; expect: Set<string>;
  roles: Array<{ staff: string; role: string }>; behaviors: Record<string, boolean>; lossReason: string;
}
const say = (s: Scene, role: "customer" | "staff", text: string, delayMin: [number, number], who?: string) => {
  s.t = daylight(s.t + int(delayMin[0], delayMin[1]) * MIN);
  s.msgs.push({ at: iso(s.t), role, text, staff_name: role === "staff" ? (who ?? s.agent.name) : undefined });
};
const cust = (s: Scene, text: string, d: [number, number]) => say(s, "customer", text, d);
const staff = (s: Scene, text: string, d?: [number, number]) => say(s, "staff", text, d ?? s.agent.reply);
const other = (s: Scene, who: string, text: string, d: [number, number]) => say(s, "staff", text, d, who);
const gap = (s: Scene, days: [number, number]) => { s.t += int(days[0], days[1]) * D + int(0, 8) * H; };

/* 語料 ———— 全部照真實觀察的語氣 */
const OPEN_C = ["你好 想問 {car} 還在嗎", "請問 {car} 這台多少", "{car} 有現車嗎", "看到 {car} 想了解一下", "這台 {car} 車況怎麼樣"];
const OPEN_S = ["您好～請問是第一次買車還是想車換車呀!!", "哈囉！{car} 還在喔 最近在看什麼類型的車呢～", "在的在的～{car} 車況很漂亮 要不要參考看看照片資訊!!"];
const OPEN_S_BUDGET = ["您好!! 方便問一下大概的預算嗎？我不亂推車，您回我一個數字就好", "哈囉～{car} 還在!! 想先了解您的預算範圍 幫您配最適合的"];
const NEED_C = ["第一次買 預算大概 {b} 萬", "想換車 舊車是 {old}", "家裡多了小孩 想找大一點的", "上班代步 省油就好", "預算 {b} 上下 可以貸款"];
const PRICE_S = ["{car} 這台 {p} 萬 含過戶 一手車 里程 {km} 公里 原廠保養", "{p} 萬 這台真的很划算 車況我敢保證!!", "報價 {p} 萬 可以來看車 現場再談～", "{car} {p} 萬 含 SAVE 認證 保固一年"];
const PRICE_Q_S = ["想先了解一下您的預算大概抓多少？有考慮貸款或舊車換購嗎 我幫您一起算方案!!", "這個價格您覺得如何？方便說一下預算 我看有沒有更適合的配法～", "您比較在意的是月付還是總價？我可以幫您試算兩種!!"];
const BUDGET_C = ["預算大概 {b} 萬 可以貸款", "總價 {b} 以內 月付不要太高", "{b} 萬左右 頭期可以多付一點"];
const OBJ_C = ["太貴了吧", "這價格有點超出預算", "可以再便宜嗎", "朋友說這款不用這麼貴", "{p} 太高 我預算只有 {b}", "有沒有更便宜的類似的"];
const OBJ_CLARIFY_S = ["了解～方便問一下您的預算大概抓多少？我看看有沒有更適合的方案或幫您爭取!!", "沒問題 那您心中的數字是多少？我直接幫您跟主管問", "我懂～您是總價考量還是月付考量？這樣我比較好幫您配"];
const OBJ_FLAT_S = ["這已經是很好的價格了", "價格就是這樣 不然您考慮看看", "好的 那您再想想"];
const NEG_S = ["價格我幫您跟主管申請看看 您方便來現場嗎!!", "您給我一個數字 我盡量幫您爭取", "現在有活動 可以送隔熱紙 價格再談談", "如果今天能決定 我幫您談到 {p2} 萬"];
const NEG_C = ["{p2} 萬可以嗎", "含過戶 {p2} 我就簽", "再少一點 我馬上訂", "好啦 {p2} 成交"];
const FIN_C = ["可以全額貸嗎", "利率大概多少", "頭期最少要多少", "月付大概多少", "我信用有點小問題 可以辦嗎", "自備款 {d} 萬夠嗎"];
const FIN_S_OK = ["可以喔 我們配合的銀行利率 {r}% 起 頭期 {d} 萬就可以", "沒問題～我幫您試算 月付大概 {m} 元", "信用問題可以先評估 我請貸款專員跟您聯絡!!"];
const FIN_S_WEAK = ["這個要問一下貸款專員", "好 我再幫您問", "應該可以 我再確認"];
const APPT_S = ["要不要約個時間來看車？週末有空嗎!!", "這禮拜六下午方便嗎？我幫您留車", "來店裡看實車比較準～您哪天有空"];
const APPT_C_YES = ["好 禮拜六下午兩點", "週日早上可以", "明天晚上七點方便嗎", "這週六好了"];
const APPT_C_NO = ["最近比較忙 再看看", "我再想想", "先不用 謝謝", "有空再約"];
const CONFIRM_S = ["好的！{when} 到店請找 {agent} 我在門口等您!!", "收到～{when} 見 車幫您留好"];
const REMIND_S = ["{agent} 提醒您 今天 {when} 賞車喔～", "今天下午見 車已經洗好了!!"];
const NOSHOW_C = ["不好意思 臨時有事 改天", "今天忘記了 抱歉", ""];
const NOSHOW_S = ["沒關係～那改約什麼時候方便呢", "了解 車先幫您留到週末 有空跟我說!!"];
const CANCEL_C = ["不好意思 先取消 家裡有事", "先不看了 抱歉"];
const AFTER_VISIT_S = ["今天謝謝您來看車～有什麼想法都可以跟我說!!", "今天看的那台喜歡嗎？價格我再跟主管爭取看看"];
const AFTER_VISIT_C_THINK = ["回去跟家人討論一下", "再考慮看看 謝謝", "價格再想想"];
const AFTER_VISIT_C_BUY = ["好 我要訂", "就這台 什麼時候可以交車", "那我下訂 訂金怎麼付"];
const SOLD_S = ["恭喜呀!! 過戶完成 交車囉～", "感謝您 交車愉快 有問題隨時找我!!"];
/** 流失時客戶說的話：跟帳本原因一致（引擎要能從文字判出原因） */
const LOST_C_BY_REASON: Record<string, string[]> = {
  price: ["預算不夠 之後再說", "價格真的差太多 先不換了"],
  competitor: ["跟朋友買了 謝謝", "買了別家的 不好意思", "在別家買了 不好意思 謝謝你"],
  changed_mind: ["先不換了 謝謝", "想想還是先不買了"],
  financing: ["貸款沒過 先不用了", "頭期湊不出來 之後再說"],
  vehicle_condition: ["車況我還是有點擔心 先不換了", "里程太多了 我再想想 先不用了"],
  trade_in: ["舊車估價差太多 先不換了", "折抵的價格我沒辦法接受 之後再說"],
  timing: ["年底再看 現在不急 之後再說", "過年後再看好了 之後再說"],
  family: ["跟老婆討論過 她不同意 先不換了", "家人反對 先不買了"],
  no_stock: ["沒關係 我要的是那台 之後再說", "那算了 我再看看別的 之後再說"],
  browsing: ["先看看而已 沒有要買 謝謝", "只是參考一下 之後再說"],
  no_response: [],
};
const LOST_S = ["沒關係～之後有需要再找我!!", "了解 祝順利 有需要隨時聯絡"];
const FU_S = ["您好～上次那台 {car} 還有興趣嗎？", "這週有新進車 要不要參考看看!!", "價格我幫您爭取到 {p2} 萬了 有空來看看嗎", "最近有沒有考慮好呀～"];
const REENGAGE_C = ["之前問的那台還在嗎", "我回來了 想再看看", "上次那台 現在多少"];
const HANDOFF_S = ["您好 我是 {agent} 接手 {prev} 的客戶 之後由我為您服務!!", "{prev} 休假 我先幫您處理～"];
const ESCALATE_S = ["我請主管看看能不能再幫您爭取 稍等我一下!!", "這個我沒辦法自己決定 我請主管跟您說"];
const MANAGER_S = ["您好 我是主管{mgr} 這台可以幫您做到 {p2} 萬 含一年保固 這是我能給的最好價格", "您好～主管{mgr} 剛看了您的需求 {p2} 萬含過戶幫您處理 車況我負責"];
const SUPPORT_ASK_C = ["這台有沒有事故 底盤有沒有問題 我有點擔心車況", "這台的保養紀錄完整嗎 有沒有泡水", "引擎有沒有異音 之前是哪裡的車"];
const SUPPORT_S = ["這台我請同事 {peer} 幫您確認 他比較懂這台!!", "我找 {peer} 來跟您說明 他驗過這台車"];
const PEER_S = ["您好 我是 {peer} 這台我有驗過 無事故 底盤乾淨 保養紀錄完整 可以放心", "{peer} 在此～這台原漆 沒泡水 保養都在原廠 有紀錄可以看"];
const REACT_S = ["上次那台 {car} 幫您談到 {p2} 萬了 這週想再看看嗎", "好久不見～{car} 還在 而且現在有活動 送隔熱紙 要不要再考慮看看!!"];
const REACT_C_YES = ["好啊 那台還在嗎", "喔 那我再考慮一下 可以約看車嗎", "還在喔 那我有空過去看"];
const INTENT_C = ["我這週就想決定 有現車就可以", "急 這個月要交車 有現車嗎", "老婆說這週要定下來 有現車我就過去"];

const fill = (t: string, s: Scene, extra: Record<string, string | number> = {}) => t
  .replace(/\{car\}/g, carName(s.car)).replace(/\{p\}/g, String(wan(s.car.list_price)))
  .replace(/\{agent\}/g, s.agent.name).replace(/\{km\}/g, String(int(3, 9) * 10_000)).replace(/\{mgr\}/g, MANAGER)
  .replace(/\{(\w+)\}/g, (_, k) => String(extra[k] ?? `{${k}}`));

/* ── 劇本建構單元（beats）──────────────────────────────── */
function beatOpen(s: Scene) {
  cust(s, fill(pick(OPEN_C), s), [0, 0]);
  const askBudget = chance(s.agent.style.clarifyBudget);
  staff(s, fill(pick(askBudget ? OPEN_S_BUDGET : OPEN_S), s));
  s.behaviors["budget_clarified"] = askBudget;
  s.expect.add("NEW_LEAD").add("VEHICLE_INTEREST");
  if (chance(0.7)) {
    const b = wan(s.car.list_price) - int(5, 25);
    cust(s, fill(pick(NEED_C), s, { b, old: pick(["Altis", "Vios", "March", "Fit"]) }), [3, 120]);
    s.expect.add("ACTIVE_DISCUSSION");
  }
}
/** 報價；照風格決定有沒有接一個診斷式問題。回傳有沒有問。 */
function beatPrice(s: Scene): boolean {
  staff(s, fill(pick(PRICE_S), s)); s.expect.add("PRICE_MENTIONED");
  const asked = chance(s.agent.style.askAfterPrice);
  if (asked) staff(s, fill(pick(PRICE_Q_S), s), [1, 8]);
  s.behaviors["asked_after_price"] = asked;
  return asked;
}
/** 報價後客戶回預算、往預約走（問了問題的人比較常走到這裡） */
function beatBudgetContinue(s: Scene) {
  cust(s, fill(pick(BUDGET_C), s, { b: wan(s.car.list_price) - int(2, 10) }), [10, 300]);
  staff(s, "好的～那這台在您預算內 我幫您排看車!!");
}
/** 價格後：客戶消失（本產品最重要的劇本）。異議後照風格決定有沒有先釐清。 */
function beatPriceDropOff(s: Scene, style: "silent" | "objection" | "cheaper"): "continued" | "dropped" {
  if (style !== "silent") {
    if (style === "objection") cust(s, fill(pick(OBJ_C), s, { b: wan(s.car.list_price) - int(10, 30) }), [10, 600]);
    else cust(s, "有沒有 {b} 萬以內的".replace("{b}", String(wan(s.car.list_price) - int(15, 30))), [10, 300]);
    s.expect.add("PRICE_OBJECTION");
    const clarified = chance(s.agent.style.objectionClarify);
    s.behaviors["objection_clarified"] = clarified;
    if (clarified) {
      staff(s, fill(pick(OBJ_CLARIFY_S), s));
      if (chance(0.45)) { beatBudgetContinue(s); return "continued"; }   // 釐清過的異議比較常救回來
    } else {
      staff(s, pick(OBJ_FLAT_S));
    }
  }
  // 之後客戶不再回，業務照跟進品質決定有沒有追
  if (chance(s.agent.followup)) { gap(s, [1, 3]); staff(s, fill(pick(FU_S), s, { p2: wan(s.car.list_price) - int(2, 6) })); s.expect.add("FOLLOW_UP"); }
  if (chance(s.agent.followup * 0.6)) { gap(s, [3, 6]); staff(s, fill(pick(FU_S), s, { p2: wan(s.car.list_price) - int(3, 8) })); }
  s.expect.add("PRICE_DROP_OFF").add("CUSTOMER_INACTIVE");
  return "dropped";
}
function beatFinancing(s: Scene, resolved: boolean) {
  cust(s, fill(pick(FIN_C), s, { d: int(5, 20) }), [5, 400]);
  s.expect.add("FINANCING_QUESTION");
  const price = s.car.list_price, d = Math.round(wan(price) * 0.2), m = Math.round((price - d * 10_000) * 1.07 / 60);
  staff(s, fill(pick(resolved ? FIN_S_OK : FIN_S_WEAK), s, { r: pick(["3.5", "3.88", "4.2"]), d, m }));
  s.behaviors["fin_answered"] = resolved;
}
function beatAppointment(s: Scene, outcome: "booked" | "declined"): number | null {
  staff(s, fill(pick(APPT_S), s)); s.expect.add("APPOINTMENT_PROPOSED");
  const proposedAt = s.t;
  if (outcome === "declined") { cust(s, pick(APPT_C_NO), [30, 900]); return null; }
  cust(s, pick(APPT_C_YES), [10, 600]);
  const when = daylight(s.t + int(1, 5) * D); const whenLocal = new Date(when + TZ);
  const label = `${whenLocal.getUTCMonth() + 1}/${whenLocal.getUTCDate()} ${String(whenLocal.getUTCHours()).padStart(2, "0")}:00`;
  staff(s, fill(pick(CONFIRM_S), s, { when: label }));
  s.appts.push({ lead_key: s.leadKey, staff_name: s.agent.name, proposed_at: iso(proposedAt), scheduled_for: iso(when), status: "booked", status_at: iso(s.t) });
  s.expect.add("APPOINTMENT_BOOKED");
  return when;
}
function beatAppointmentDay(s: Scene, when: number, result: "show" | "no_show" | "cancel" | "reschedule"): number | null {
  const last = s.appts[s.appts.length - 1]!;
  s.t = when - int(2, 5) * H; staff(s, fill(pick(REMIND_S), s, { when: "下午" }), [0, 0]);
  if (result === "cancel") { cust(s, pick(CANCEL_C), [30, 180]); last.status = "cancelled"; last.status_at = iso(s.t); s.expect.add("APPOINTMENT_CANCELLED"); return null; }
  if (result === "reschedule") {
    cust(s, "不好意思 可以改下週嗎", [30, 180]); staff(s, "可以喔～下週六同一時間好嗎!!"); cust(s, "好", [10, 120]);
    const nw = when + 7 * D; last.status = "rescheduled"; last.status_at = iso(s.t);
    s.appts.push({ lead_key: s.leadKey, staff_name: s.agent.name, proposed_at: iso(s.t), scheduled_for: iso(nw), status: "booked", status_at: iso(s.t) });
    s.expect.add("APPOINTMENT_CHANGED"); return nw;
  }
  if (result === "no_show") {
    s.t = when + int(1, 3) * H; const c = pick(NOSHOW_C); if (c) cust(s, c, [0, 0]);
    staff(s, fill(pick(NOSHOW_S), s)); last.status = "no_show"; last.status_at = iso(s.t); s.expect.add("NO_SHOW"); return null;
  }
  s.t = when; last.status = "completed"; last.status_at = iso(when); return when;
}
/** 到店；沒當場買的話，到店後多久跟進照風格 */
function beatVisit(s: Scene, at: number, outcome: "bought" | "negotiating" | "left", afterAppt: boolean) {
  s.t = at + int(1, 3) * H;
  s.visits.push({ lead_key: s.leadKey, staff_name: s.agent.name, visited_at: iso(at), outcome, note: "", after_appointment: afterAppt });
  s.expect.add("STORE_VISIT");
  if (outcome === "bought") { staff(s, fill(pick(AFTER_VISIT_S), s), [30, 120]); cust(s, pick(AFTER_VISIT_C_BUY), [10, 600]); return; }
  const [a, b] = s.agent.style.postVisitH;
  const hours = int(a, b);
  staff(s, fill(pick(AFTER_VISIT_S), s), [hours * 60, hours * 60 + 30]);
  s.behaviors["postvisit_24h"] = hours <= 24;
  cust(s, pick(AFTER_VISIT_C_THINK), [30, 900]);
}
function beatNegotiation(s: Scene, rounds: number, agree: boolean): number {
  let p2 = wan(s.car.list_price);
  for (let i = 0; i < rounds; i++) {
    p2 -= int(1, 4);
    cust(s, fill(pick(NEG_C), s, { p2 }), [10, 400]);
    staff(s, fill(pick(NEG_S), s, { p2: p2 + 1 }));
  }
  s.expect.add("NEGOTIATION");
  if (agree) { cust(s, `好 ${p2} 萬成交`, [10, 300]); }
  return p2 * 10_000;
}
function beatSold(s: Scene, price: number, deals: BundleDeal[], extraGP = 0) {
  gap(s, [1, 4]); staff(s, pick(SOLD_S));
  const cost = s.car.cost - extraGP;
  const salePrice = chance(0.4) ? price + int(-9, 9) * 1000 : price;      // 過戶規費零頭，真單不會全是整數萬
  deals.push({ lead_key: s.leadKey, customer_key: s.cust.key, staff_name: s.agent.name, vehicle_key: s.car.key,
    status: "sold", sale_price: salePrice, cost, gross_profit: salePrice - cost, lost_reason: "", closed_at: iso(s.t),
    external_key: s.cust.external_key });
  s.expect.add("SOLD");
}
/** 帳本原因 → 引擎的流失原因鍵（標準答案） */
const LOSS_KEY: Record<string, string> = {
  price: "price_resistance", competitor: "bought_elsewhere", changed_mind: "timing", financing: "financing",
  vehicle_condition: "vehicle_condition", trade_in: "trade_in", timing: "timing", family: "family", no_stock: "no_stock",
  browsing: "browsing", no_response: "stopped_replying",
};
function beatLost(s: Scene, reason: LostReason, deals: BundleDeal[], explicit = true, lossKey?: string) {
  if (explicit) { gap(s, [1, 7]); const txt = LOST_C_BY_REASON[reason]; if (txt?.length) cust(s, pick(txt), [0, 0]); staff(s, pick(LOST_S)); }
  deals.push({ lead_key: s.leadKey, customer_key: s.cust.key, staff_name: s.agent.name, vehicle_key: s.car.key,
    status: "lost", sale_price: 0, cost: 0, gross_profit: 0, lost_reason: reason, closed_at: iso(s.t + D),
    external_key: s.cust.external_key });
  s.expect.add("LOST");
  s.lossReason = lossKey ?? LOSS_KEY[reason] ?? "other";
}
function beatFollowups(s: Scene, n: number, quality: number) {
  for (let i = 0; i < n; i++) { if (!chance(quality)) continue; gap(s, [2, 5]); staff(s, fill(pick(FU_S), s, { p2: wan(s.car.list_price) - int(2, 6) })); s.expect.add("FOLLOW_UP"); }
}
/** 報價後往預約→到店→成交走（共用的「順路」） */
function beatConvert(s: Scene, deals: BundleDeal[], buyP: number, discountWan = 0): "sold" | "" {
  const w = beatAppointment(s, "booked"); if (!w) return "";
  beatAppointmentDay(s, w, "show");
  const buy = chance(buyP);
  beatVisit(s, w, buy ? "bought" : "negotiating", true);
  if (buy) { beatSold(s, s.car.list_price - discountWan * 10_000, deals); return "sold"; }
  beatFollowups(s, 1, s.agent.followup); return "";
}

/* ── 劇本 ─────────────────────────────────────────────── */
type Result = { outcome: "" | "sold" | "lost"; price_dropoff: boolean; weak_followup: boolean; grade: string };
type ScenarioFn = (s: Scene, deals: BundleDeal[], assignments: BundleAssignment[]) => Result;
const R = (outcome: Result["outcome"], grade: string, price_dropoff = false, weak_followup = false): Result => ({ outcome, price_dropoff, weak_followup, grade });
const SCENARIOS: Array<{ name: string; weight: number; car?: () => BundleVehicle; agent?: (a: Profile[]) => Profile; run: ScenarioFn }> = [
  { name: "01_price_then_disappear", weight: 14, run: (s, d) => {
    beatOpen(s); const asked = beatPrice(s);
    if (asked && chance(0.45)) { beatBudgetContinue(s); const o = beatConvert(s, d, 0.5, int(0, 3)); return R(o, o ? "S" : "A"); }   // 問了問題的比較常走下去
    const st = pick(["silent", "silent", "objection"] as const);
    if (beatPriceDropOff(s, st) === "continued") { const o = beatConvert(s, d, 0.5, int(1, 3)); return R(o, o ? "S" : "A"); }
    beatLost(s, "no_response", d, false, st === "silent" ? "stopped_replying" : "price_resistance"); return R("lost", "B", true, s.agent.followup < 0.5); } },
  { name: "02_price_then_continue", weight: 10, run: (s, d) => { beatOpen(s); beatPrice(s); cust(s, "好 那還可以 都在預算內", [10, 200]); const o = beatConvert(s, d, 0.5, int(0, 3)); if (!o) beatFollowups(s, 1, s.agent.followup); return R(o, o ? "S" : "A"); } },
  { name: "03_negotiation", weight: 8, run: (s, d) => { beatOpen(s); beatPrice(s); const p = beatNegotiation(s, int(2, 3), chance(0.6)); if (s.msgs.at(-1)!.text.includes("成交")) { beatSold(s, p, d); return R("sold", "S"); } beatFollowups(s, 1, s.agent.followup); return R("", "A"); } },
  { name: "04_financing_question", weight: 8, run: (s, d) => { beatOpen(s); beatPrice(s); const ok = chance(s.agent.style.finAnswer); beatFinancing(s, ok); if (ok) { const o = beatConvert(s, d, 0.85); return R(o, o ? "S" : "A"); } gap(s, [2, 5]); s.expect.add("CUSTOMER_INACTIVE"); return R("", "B", false, true); } },
  { name: "05_books_appointment", weight: 6, run: (s) => { beatOpen(s); beatPrice(s); beatAppointment(s, "booked"); return R("", "A"); } },
  { name: "06_books_then_no_show", weight: 7, run: (s, d) => { beatOpen(s); beatPrice(s); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "no_show"); if (chance(0.5)) { gap(s, [3, 8]); s.expect.add("CUSTOMER_INACTIVE"); beatLost(s, "no_response", d, false, "no_show"); return R("lost", "B"); } beatFollowups(s, 1, s.agent.followup); return R("", "B"); } },
  { name: "07_visit_no_buy", weight: 8, run: (s, d) => {
    beatOpen(s); beatPrice(s); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "left", true);
    const fast = s.behaviors["postvisit_24h"] === true;
    if (chance(fast ? 0.45 : 0.15)) { gap(s, [1, 3]); cust(s, "想清楚了 我要訂", [0, 0]); beatSold(s, s.car.list_price - int(0, 2) * 10_000, d); return R("sold", "S"); }
    beatFollowups(s, 2, s.agent.followup);
    if (chance(0.6)) { const r = pick(["price", "competitor", "changed_mind"] as const); beatLost(s, r, d); return R("lost", "B"); } return R("", "A"); } },
  { name: "08_visit_and_buy", weight: 9, run: (s, d) => { beatOpen(s); beatPrice(s); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "bought", true); const p = chance(0.5) ? beatNegotiation(s, 1, true) : s.car.list_price; beatSold(s, p, d); return R("sold", "S"); } },
  { name: "09_strong_lead_weak_followup", weight: 7, agent: (a) => pick(a.filter((x) => x.followup < 0.5)), run: (s, d) => { beatOpen(s); cust(s, "我這週就想決定 有現車就可以", [5, 60]); s.expect.add("HIGH_INTENT"); s.behaviors["proposed_after_intent"] = false; beatPrice(s); cust(s, "好 什麼時候可以看車", [10, 120]); gap(s, [2, 4]); s.expect.add("CUSTOMER_INACTIVE"); beatLost(s, "no_response", d, false, "slow_response"); return R("lost", "A", false, true); } },
  { name: "10_high_intent_good_followup", weight: 5, agent: (a) => pick(a.filter((x) => x.followup >= 0.8)), run: (s, d) => { beatOpen(s); cust(s, "急 這個月要交車 有現車嗎", [5, 60]); s.expect.add("HIGH_INTENT"); s.behaviors["proposed_after_intent"] = true; beatPrice(s); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "bought", true); beatSold(s, s.car.list_price - int(0, 2) * 10_000, d); return R("sold", "S"); } },
  { name: "11_goes_inactive", weight: 10, run: (s) => { beatOpen(s); if (chance(0.5)) beatPrice(s); gap(s, [5, 12]); s.expect.add("CUSTOMER_INACTIVE"); beatFollowups(s, 1, s.agent.followup); return R("", "C", false, s.agent.followup < 0.5); } },
  { name: "12_re_engages", weight: 5, run: (s, d) => { beatOpen(s); beatPrice(s); gap(s, [8, 15]); s.expect.add("CUSTOMER_INACTIVE"); cust(s, pick(REENGAGE_C), [0, 0]); s.expect.add("RE_ENGAGED"); staff(s, "還在喔!! 而且價格幫您談到 {p2} 萬".replace("{p2}", String(wan(s.car.list_price) - 3))); const o = beatConvert(s, d, 0.85, 3); return R(o, o ? "S" : "A"); } },
  { name: "13_staff_handoff", weight: 4, run: (s, d, asg) => {
    beatOpen(s); beatPrice(s); const prev = s.agent.name; const next = pick(AGENTS.filter((a) => a.name !== prev)); s.agent = next; gap(s, [1, 2]);
    staff(s, fill(pick(HANDOFF_S), s, { prev }));
    asg.push({ conversation_key: s.convKey, from_staff: prev, to_staff: next.name, by_staff: MANAGER, at: iso(s.t) });
    s.roles.push({ staff: prev, role: "handoff_from" }, { staff: next.name, role: "handoff_to" });
    cust(s, "好 那價格一樣嗎", [30, 600]); beatPrice(s); const w = beatAppointment(s, chance(0.6) ? "booked" : "declined");
    if (w) { beatAppointmentDay(s, w, "show"); beatVisit(s, w, "negotiating", true); beatFollowups(s, 1, next.followup); } return R("", "A"); } },
  { name: "14_long_cycle", weight: 4, run: (s, d) => { beatOpen(s); beatPrice(s); beatFinancing(s, true); gap(s, [10, 20]); beatFollowups(s, 2, 0.9); gap(s, [7, 14]); cust(s, "考慮好了 想再看一次", [0, 0]); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "bought", true); beatSold(s, s.car.list_price - int(1, 3) * 10_000, d); return R("sold", "S"); } },
  { name: "15_fast_transaction", weight: 4, run: (s, d) => { beatOpen(s); beatPrice(s); cust(s, "好 我明天過去看 沒問題就訂", [5, 60]); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "bought", true); beatSold(s, s.car.list_price, d); return R("sold", "S"); } },
  { name: "16_discount_discussion", weight: 5, run: (s, d) => { beatOpen(s); beatPrice(s); cust(s, "有沒有折扣 或送什麼", [10, 300]); staff(s, "可以送隔熱紙跟行車紀錄器 價格再折 2 萬!!"); const p = beatNegotiation(s, 1, chance(0.5)); if (s.msgs.at(-1)!.text.includes("成交")) { beatSold(s, p, d); return R("sold", "S"); } beatFollowups(s, 1, s.agent.followup); return R("", "A"); } },
  { name: "17_high_gross_profit", weight: 3, car: () => carByTag("quiet_high"), run: (s, d) => { beatOpen(s); beatPrice(s); cust(s, "好 可以來看", [10, 200]); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "bought", true); beatSold(s, s.car.list_price, d, 20_000); return R("sold", "S"); } },
  { name: "18_low_gross_profit", weight: 3, car: () => carByTag("hot_low"), run: (s, d) => { beatOpen(s); beatPrice(s); const p = beatNegotiation(s, 3, true); beatSold(s, p - 30_000, d); return R("sold", "S"); } },
  { name: "19_hot_vehicle_low_conversion", weight: 6, car: () => carByTag("hot_low"), run: (s, d) => { beatOpen(s); beatPrice(s); const st = pick(["objection", "cheaper", "silent"] as const); if (beatPriceDropOff(s, st) === "continued") { const o = beatConvert(s, d, 0.4, int(1, 3)); return R(o, o ? "S" : "A"); } beatLost(s, "price", d, false, "price_resistance"); return R("lost", "B", true); } },
  { name: "20_quiet_vehicle_high_conversion", weight: 4, car: () => carByTag("quiet_high"), run: (s, d) => { beatOpen(s); beatPrice(s); cust(s, "價格合理 我想看車", [10, 300]); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "bought", true); beatSold(s, s.car.list_price, d); return R("sold", "S"); } },
  { name: "21_price_sensitive", weight: 4, run: (s, d) => { beatOpen(s); beatPrice(s); if (beatPriceDropOff(s, "cheaper") === "continued") { const o = beatConvert(s, d, 0.4, int(2, 5)); return R(o, o ? "S" : "A"); } staff(s, "有一台 {alt} 比較符合預算 要不要參考".replace("{alt}", carName(anyCar()))); cust(s, "好 那台多少", [30, 600]); staff(s, "{p} 萬 含過戶".replace("{p}", String(wan(s.car.list_price) - 15))); gap(s, [3, 6]); s.expect.add("CUSTOMER_INACTIVE"); return R("", "B", true); } },
  { name: "22_financing_sensitive", weight: 4, run: (s, d) => { beatOpen(s); beatPrice(s); beatFinancing(s, false); cust(s, "那頭期到底要多少 沒辦法決定", [60, 900]); staff(s, pick(FIN_S_WEAK)); gap(s, [3, 7]); s.expect.add("CUSTOMER_INACTIVE"); beatLost(s, "financing", d, false); return R("lost", "B", false, true); } },
  { name: "23_repeat_customer", weight: 3, run: (s, d) => { cust(s, "之前跟你買過 {old} 這次想換 {car}".replace("{old}", "Altis").replace("{car}", carName(s.car)), [0, 0]); staff(s, "老客戶!! 這台幫您留 價格一定給您好"); s.expect.add("NEW_LEAD").add("VEHICLE_INTEREST").add("HIGH_INTENT"); beatPrice(s); const w = beatAppointment(s, "booked")!; s.behaviors["proposed_after_intent"] = true; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "bought", true); beatSold(s, s.car.list_price - 2 * 10_000, d); return R("sold", "S"); } },
  { name: "24_multiple_conversations", weight: 3, run: (s, d) => { beatOpen(s); beatPrice(s); gap(s, [4, 8]); cust(s, "上次問的那台 車況再多給我幾張照片", [0, 0]); staff(s, "好的 傳給您!! 這台真的很漂亮"); s.msgs.push({ at: iso(s.t + MIN), role: "staff", text: "［圖片］", type: "image", staff_name: s.agent.name }); gap(s, [3, 6]); cust(s, "好 我想看車了", [0, 0]); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "bought", true); beatSold(s, s.car.list_price - 10_000, d); return R("sold", "S"); } },

  /* ── 新增：行為差異、協作、流失原因 ── */
  { name: "25_high_intent_by_style", weight: 6, run: (s, d) => {
    beatOpen(s); cust(s, pick(INTENT_C), [5, 60]); s.expect.add("HIGH_INTENT"); beatPrice(s);
    const proposed = chance(s.agent.style.proposeAfterIntent); s.behaviors["proposed_after_intent"] = proposed;
    if (proposed) { const o = beatConvert(s, d, 0.7, int(0, 2)); return R(o, o ? "S" : "A"); }
    cust(s, "好 什麼時候可以看車", [10, 120]);
    staff(s, "好喔 我看一下時間再跟您說", [s.agent.reply[1], s.agent.reply[1] * 3]);
    gap(s, [3, 6]); s.expect.add("CUSTOMER_INACTIVE"); beatLost(s, "no_response", d, false, "weak_followup"); return R("lost", "A", false, true); } },
  { name: "26_manager_intervention", weight: 5, run: (s, d) => {
    beatOpen(s); beatPrice(s); cust(s, fill(pick(OBJ_C), s, { b: wan(s.car.list_price) - int(8, 20) }), [10, 600]); s.expect.add("PRICE_OBJECTION");
    staff(s, pick(ESCALATE_S)); s.behaviors["escalated"] = true;
    const p2 = wan(s.car.list_price) - int(3, 6);
    other(s, MANAGER, fill(pick(MANAGER_S), s, { p2 }), [20, 180]); s.roles.push({ staff: MANAGER, role: "manager" });
    cust(s, `好 那 ${p2} 萬可以嗎`, [10, 300]); s.expect.add("NEGOTIATION");
    staff(s, "可以!! 主管同意了 我幫您安排看車");
    const o = beatConvert(s, d, 0.75, wan(s.car.list_price) - p2); return R(o, o ? "S" : "A"); } },
  { name: "27_colleague_support", weight: 5, run: (s, d) => {
    beatOpen(s); cust(s, pick(SUPPORT_ASK_C), [5, 300]);
    const peer = pick(AGENTS.filter((a) => a.name !== s.agent.name)).name;
    staff(s, fill(pick(SUPPORT_S), s, { peer })); other(s, peer, fill(pick(PEER_S), s, { peer }), [15, 240]); s.roles.push({ staff: peer, role: "supporting" });
    cust(s, "好 那我放心多了", [10, 200]); beatPrice(s);
    if (chance(0.6)) { const o = beatConvert(s, d, 0.6, int(0, 2)); return R(o, o ? "S" : "A"); }
    beatFollowups(s, 1, s.agent.followup); return R("", "A"); } },
  { name: "28_staff_reactivation", weight: 5, run: (s, d) => {
    beatOpen(s); beatPrice(s); cust(s, "好 我考慮一下", [10, 300]); gap(s, [8, 15]); s.expect.add("CUSTOMER_INACTIVE");
    if (chance(s.agent.followup)) {
      staff(s, fill(pick(REACT_S), s, { p2: wan(s.car.list_price) - int(2, 4) }), [0, 0]); s.expect.add("FOLLOW_UP");
      cust(s, pick(REACT_C_YES), [60, 2 * 24 * 60]); s.expect.add("RE_ENGAGED");
      s.roles.push({ staff: s.agent.name, role: "reactivation" }); s.behaviors["reactivated_by_staff"] = true;
      const o = beatConvert(s, d, 0.6, int(2, 4)); return R(o, o ? "S" : "A");
    }
    s.behaviors["reactivated_by_staff"] = false; beatLost(s, "no_response", d, false, "stopped_replying"); return R("lost", "B", false, true); } },
  { name: "29_vehicle_condition", weight: 3, run: (s, d) => { beatOpen(s); beatPrice(s); cust(s, "這台有沒有事故 里程 12 萬有點多 我有點擔心車況", [10, 300]); staff(s, "無事故喔 有第三方檢測報告 可以來看實車!!"); s.expect.add("APPOINTMENT_PROPOSED"); beatLost(s, "vehicle_condition", d); return R("lost", "B"); } },
  { name: "30_trade_in", weight: 3, run: (s, d) => { beatOpen(s); beatPrice(s); cust(s, "我的舊車可以折抵多少 2018 的 Altis", [10, 300]); staff(s, "舊車估價大概 {x} 萬 要看實車才準".replace("{x}", String(int(20, 30)))); beatLost(s, "trade_in", d); return R("lost", "B"); } },
  { name: "31_family_decision", weight: 3, run: (s, d) => { beatOpen(s); beatPrice(s); const w = beatAppointment(s, "booked")!; beatAppointmentDay(s, w, "show"); beatVisit(s, w, "left", true); beatLost(s, "family", d); return R("lost", "B"); } },
  { name: "32_timing", weight: 3, run: (s, d) => { beatOpen(s); beatPrice(s); beatLost(s, "timing", d); return R("lost", "C"); } },
  { name: "33_bought_elsewhere", weight: 3, run: (s, d) => { beatOpen(s); beatPrice(s); cust(s, "好 我比較一下", [10, 300]); beatFollowups(s, 1, s.agent.followup); beatLost(s, "competitor", d); return R("lost", "B"); } },
  { name: "34_no_stock", weight: 2, run: (s, d) => { cust(s, fill(pick(OPEN_C), s), [0, 0]); staff(s, "不好意思 那台剛賣掉了 有另一台 {alt} 要參考嗎".replace("{alt}", carName(anyCar()))); s.expect.add("NEW_LEAD").add("VEHICLE_INTEREST"); beatLost(s, "no_stock", d); return R("lost", "C"); } },
  { name: "35_browsing", weight: 3, run: (s, d) => { beatOpen(s); beatPrice(s); beatLost(s, "browsing", d); return R("lost", "C"); } },
  { name: "36_negotiation_failed", weight: 3, run: (s, d) => { beatOpen(s); beatPrice(s); beatNegotiation(s, 2, false); staff(s, "這個價格真的沒辦法 已經是底價了"); beatLost(s, "price", d, true, "negotiation_failed"); return R("lost", "B"); } },
  { name: "37_slow_response_loss", weight: 4, agent: (a) => pick(a.filter((x) => x.reply[1] >= 400)), run: (s, d) => { cust(s, fill(pick(OPEN_C), s), [0, 0]); cust(s, "在嗎", [180, 600]); staff(s, fill(pick(OPEN_S), s), [s.agent.reply[1], s.agent.reply[1] * 2]); s.expect.add("NEW_LEAD").add("VEHICLE_INTEREST").add("ACTIVE_DISCUSSION"); cust(s, "怎麼這麼久才回 我先問別家 之後再說", [10, 120]); staff(s, pick(LOST_S)); beatLost(s, "no_response", d, false, "slow_response"); return R("lost", "C", false, true); } },
  { name: "38_weak_followup_loss", weight: 4, agent: (a) => pick(a.filter((x) => x.followup < 0.5)), run: (s, d) => { beatOpen(s); beatPrice(s); cust(s, "好 我考慮一下", [10, 300]); gap(s, [10, 20]); s.expect.add("CUSTOMER_INACTIVE"); beatLost(s, "no_response", d, false, "stopped_replying"); return R("lost", "B", false, true); } },
];

/* ── 主流程 ────────────────────────────────────────────── */
const customers: BundleCustomer[] = [], leads: BundleLead[] = [], conversations: BundleConversation[] = [];
const appointments: BundleAppointment[] = [], visits: BundleVisit[] = [], deals: BundleDeal[] = [], assignments: BundleAssignment[] = [];
const truth: TruthLabel[] = [];
let n = 0;
const totalW = SCENARIOS.reduce((a, s) => a + s.weight, 0);

for (const sc of SCENARIOS) {
  for (let i = 0; i < sc.weight; i++) {
    n++;
    const agent = sc.agent ? sc.agent(AGENTS) : pick(AGENTS);
    const car = sc.car ? sc.car() : anyCar();
    const start = leadStart();
    const name = pick(SURNAME) + (chance(0.5) ? pick(GIVEN) : "") + pick(TITLE);
    const d0 = new Date(start + TZ);
    const datePrefix = `${d0.getUTCMonth() + 1}/${String(d0.getUTCDate()).padStart(2, "0")}`;
    const custKey = `C${n}`, leadKey = `L${n}`, convKey = `CV${n}`;
    const cust: BundleCustomer = {
      key: custKey, display_name: `${datePrefix}${name}`, pseudonym: `客戶#${String(n).padStart(3, "0")}`,
      phone: `09${int(10, 88)}-${String(int(0, 999)).padStart(3, "0")}-${String(int(0, 999)).padStart(3, "0")}`,
      grade: "C", external_key: "", first_contact_at: iso(start), blocked: 0,
    };
    cust.external_key = cust.phone;
    const scene: Scene = { t: start, agent, car, cust, msgs: [], appts: [], visits: [], leadKey, convKey, expect: new Set(), roles: [], behaviors: {}, lossReason: "" };
    const r = sc.run(scene, deals, assignments);
    cust.grade = r.grade;
    // 標準答案要描述「資料」而不是「劇本作者的意圖」：
    // ACTIVE_DISCUSSION＝48 小時內客戶 ≥2 則且業務 ≥1 則，這是結構事實
    const t0 = Date.parse(scene.msgs[0]!.at), w = t0 + 48 * H;
    const c48 = scene.msgs.filter((m) => m.role === "customer" && Date.parse(m.at) <= w).length;
    const s48 = scene.msgs.filter((m) => m.role === "staff" && Date.parse(m.at) <= w).length;
    if (c48 >= 2 && s48 >= 1) scene.expect.add("ACTIVE_DISCUSSION"); else scene.expect.delete("ACTIVE_DISCUSSION");
    // 報價之後客戶再也沒回＝價格後流失，不管劇本叫什麼名字
    const pIdx = scene.msgs.findIndex((m) => m.role === "staff" && /(\d{2,3})\s*萬|報價|含過戶/.test(m.text));
    if (pIdx >= 0 && !scene.msgs.slice(pIdx + 1).some((m) => m.role === "customer") && r.outcome !== "sold") {
      r.price_dropoff = true; scene.expect.add("PRICE_DROP_OFF");
    }
    // 主要業務＝最後負責的人（交接後是接手的人）
    scene.roles.unshift({ staff: scene.agent.name, role: "primary" });
    // 公司習慣：成交的客戶在顯示名稱後面加「已購車」
    if (r.outcome === "sold") cust.display_name += "-已購車";
    if (r.outcome === "lost" && chance(0.15)) cust.blocked = 1;
    const source = pick<LeadSource>(["meta", "meta", "ig", "line_search", "line_search", "referral"]);
    const lastAt = scene.msgs[scene.msgs.length - 1]!.at;
    customers.push(cust);
    leads.push({ key: leadKey, customer_key: custKey, staff_name: scene.agent.name, vehicle_key: car.key, source,
      opened_at: iso(start), closed_at: r.outcome ? lastAt : null, outcome: r.outcome });
    conversations.push({ key: convKey, customer_key: custKey, lead_key: leadKey, channel: "line",
      assigned_staff: scene.agent.name, messages: scene.msgs });
    appointments.push(...scene.appts); visits.push(...scene.visits);
    const label: TruthLabel = { lead_key: leadKey, scenario: sc.name, expect_events: [...scene.expect], price_dropoff: r.price_dropoff, weak_followup: r.weak_followup, roles: scene.roles, behaviors: scene.behaviors };
    if (r.outcome === "lost") label.loss_reason = scene.lossReason;
    truth.push(label);
  }
}
// 賣掉的車標記
for (const d of deals) if (d.status === "sold") { const v = VEHICLES.find((x) => x.key === d.vehicle_key); if (v) v.stock_status = "sold"; }

const bundle: NormalizedBundle = {
  source_system: "mock", generated_at: iso(NOW),
  teams: ["管理", "業務一組", "業務二組"], staff: STAFF, vehicles: VEHICLES,
  customers, leads, conversations, appointments, visits, deals, assignments,
};
mkdirSync("data/mock", { recursive: true });
writeFileSync("data/mock/bundle.json", JSON.stringify(bundle, null, 1));
writeFileSync("data/mock/truth.json", JSON.stringify(truth, null, 1));

const msgs = conversations.reduce((a, c) => a + c.messages.length, 0);
const sold = deals.filter((d) => d.status === "sold"), lost = deals.filter((d) => d.status === "lost");
const gp = sold.reduce((a, d) => a + d.gross_profit, 0);
console.log(`leads ${leads.length} / conversations ${conversations.length} / messages ${msgs} / assignments ${assignments.length}`);
console.log(`appointments ${appointments.length} / visits ${visits.length} / deals ${deals.length} (sold ${sold.length}, lost ${lost.length})`);
console.log(`revenue NT$${sold.reduce((a, d) => a + d.sale_price, 0).toLocaleString()} / gross profit NT$${gp.toLocaleString()}`);
console.log(`price drop-off (truth) ${truth.filter((t) => t.price_dropoff).length} / weak follow-up ${truth.filter((t) => t.weak_followup).length}`);
const lr: Record<string, number> = {}; for (const t of truth) if (t.loss_reason) lr[t.loss_reason] = (lr[t.loss_reason] ?? 0) + 1;
console.log(`loss reasons (truth):`, lr);
console.log(`roles (truth):`, truth.flatMap((t) => t.roles ?? []).reduce<Record<string, number>>((a, r) => { a[r.role] = (a[r.role] ?? 0) + 1; return a; }, {}));
console.log(`scenario weights sum ${totalW}`);
