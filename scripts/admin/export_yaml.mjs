// 匯出 docs/labels.yaml（系統的標籤定義，從程式碼讀）與 docs/staff.yaml（員工＋暱稱，從正式站讀），給 Frank 那邊用同一套標籤對照準確率。
//   node scripts/admin/export_yaml.mjs [base_url]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..") + "/";
const BASE = process.argv[2] || "https://ai-command-center.curry06240624.workers.dev";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
let cookie = "";
async function api(path, body) {
  const r = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", cookie, "user-agent": UA }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return r.json();
}
const y = (s) => JSON.stringify(String(s));   // YAML-safe scalar
const objLit = (src, name) => { const i = src.indexOf(`export const ${name} = `); const j = src.indexOf("};", i); return Function(`return (${src.slice(i + `export const ${name} = `.length, j + 1)})`)(); };
const ui = readFileSync(ROOT + "public/app/ui.js", "utf8");
const EVENT = objLit(ui, "EVENT"), GRADE = objLit(ui, "GRADE");
const loss = readFileSync(ROOT + "src/engine/loss.ts", "utf8");
const LOSS = Function(`return (${loss.slice(loss.indexOf("= {", loss.indexOf("export const LOSS_LABEL")) + 2, loss.indexOf("};", loss.indexOf("export const LOSS_LABEL")) + 1)})`)();
const STAGE = Function(`return (${loss.slice(loss.indexOf("= {", loss.indexOf("export const STAGE_LABEL")) + 2, loss.indexOf("};", loss.indexOf("export const STAGE_LABEL")) + 1)})`)();
const beh = readFileSync(ROOT + "src/engine/behavior.ts", "utf8");
const FEAT = Function(`return (${beh.slice(beh.indexOf("= {", beh.indexOf("export const FEATURE_LABEL")) + 2, beh.indexOf("};", beh.indexOf("export const FEATURE_LABEL")) + 1)})`)();

const EVENT_DEF = {
  NEW_LEAD: "第一則非選單客戶訊息（打字／照片／貼圖）；只點選單的不算進線", VEHICLE_INTEREST: "對話提到車輛主檔的車款，或客戶按車卡「我要了解」", ACTIVE_DISCUSSION: "48 小時內客戶 ≥2 則、業務 ≥1 則",
  HIGH_INTENT: "前四則客戶訊息有急迫用語（很急／急需／這週就要…；不急／應急不算）", PRICE_MENTIONED: "業務親自報車價或月繳（開價 X／X 萬含過戶／月繳抓 X）；客戶點車卡、業務問預算不算",
  PRICE_OBJECTION: "報價後客戶討價（太貴／可以便宜嗎／X 萬以內）", NEGOTIATION: "報價後客戶出價（X 萬可以嗎／X 萬我就簽）", FINANCING_QUESTION: "客戶用問句問貸款／利率／頭期／月繳；detail.resolved＝業務 24 小時內有具體答案",
  APPOINTMENT_PROPOSED: "業務提議來店／看車", APPOINTMENT_BOOKED: "客戶給了時間且業務確認（或預約紀錄）", APPOINTMENT_CHANGED: "改期", APPOINTMENT_CANCELLED: "取消", NO_SHOW: "爽約",
  STORE_VISIT: "接待群到店紀錄（或預約後業務說「今天看的車」）", FOLLOW_UP: "客戶沉默 ≥24 小時後業務主動訊息", CUSTOMER_INACTIVE: "客戶沉默 ≥7 天", RE_ENGAGED: "沉默 ≥7 天後客戶再發訊",
  SOLD: "成交帳本（成交群收訂單／車源表／送貨囉）或業務說已交車／過戶完成（過去式）", LOST: "客戶明說不買、顯示名稱標 ❌、或沉默 ≥21 天（推定，confidence POSSIBLE）", PRICE_DROP_OFF: "業務報價後客戶消失 ≥72 小時或異議後沉默（無後續正向事件）",
};
const CONF = { CONFIRMED: "確定", STRONGLY_SUGGESTED: "強烈建議", POSSIBLE: "可能", UNCLEAR: "不確定" };
let L = "# labels.yaml —— 訊息到成交 AI 影子控制台 的標籤定義（2026-09-09 匯出，來源：src/engine/funnel.ts、grade.ts、loss.ts、behavior.ts）\n";
L += "# 用途：兩套分析用同一組標籤，準確率才能對照。事件以「lead（客戶旅程）」為單位，每個事件帶 confidence 與證據訊息 id。\n\n";
L += "message:\n  roles: [customer, staff, bot]\n  types: [text, menu, sticker, image, video, audio, file, location]\n  menu_note: " + y("menu＝圖文選單／按鈕文字（含沒 emoji 的按鈕：回選單、貸款、想了解月繳款、X庫存N台、X就是你了…，清單在 src/model/menu.ts）；不算客戶打字") + "\n\n";
L += "confidence:\n" + Object.entries(CONF).map(([k, v]) => `  ${k}: ${y(v)}`).join("\n") + "\n\n";
L += "funnel_events:\n" + Object.entries(EVENT).map(([k, v]) => `  ${k}:\n    label: ${y(v)}\n    rule: ${y(EVENT_DEF[k] ?? "")}`).join("\n") + "\n\n";
L += "stages:   # 由事件推出的目前階段（順序）\n" + Object.entries(STAGE).map(([k, v]) => `  ${k}: ${y(v)}`).join("\n") + "\n  closed: \"結案（成交或流失，推定流失不算結案）\"\n\n";
L += "sabc:   # 系統推算（公司規則見 docs/SABC_RULES.md）\n" + Object.entries(GRADE).map(([k, v]) => `  ${k}: ${y(v)}`).join("\n") + "\n";
L += "  rules:\n    S: " + y("已發生高推進動作：預約成立／到店／成交紀錄，或客戶說已付訂／匯訂／下訂／視訊過，或員工確認收到訂金／拉群／送件／過件／撥款（員工提議不算）") + "\n    A: " + y("有真人對談＋車款已知＋客戶自己講過預算／月繳") + "\n    B: " + y("有真人對談，車款或錢缺一") + "\n    C: " + y("沒有真人對談（只按選單、只有機器人、或客戶打了字沒人回）") + "\n";
L += "  result_tags: [長週期, 已送貸, 未過件, 純研究]\n\n";
L += "loss_reasons:\n" + Object.entries(LOSS).map(([k, v]) => `  ${k}: ${y(v)}`).join("\n") + "\n  driver: [customer, process, unclear]   # process＝slow_response／weak_followup（公司可以改的）\n\n";
L += "behavior_features:   # 每個 lead 一組，員工效能／教練用\n" + Object.entries(FEAT).map(([k, v]) => `  ${k}: { label: ${y(v.label)}, unit: ${v.unit}, good_is_up: ${v.goodIsUp}, situation: ${y(v.situation)} }`).join("\n") + "\n\n";
L += "deal_report:   # 成交群貼文（收訂囉／送貸囉／過件囉／售出囉）\n  stage: [deposit, loan_sent, loan_approved, delivered]\n  loan_status: [pending, approved, rejected, none]   # none＝現金\n  delivered: " + y("售出囉＝1；收訂／送貸／過件＝0（收訂就算成交，未交車）") + "\n  closed_at_source: [\"\", import, sheet_diff]   # ''＝真成交日（貼文時間）；import＝車源表第一次匯入、日期不明、不算本期\n";
writeFileSync(ROOT + "docs/labels.yaml", L); console.log("wrote docs/labels.yaml", L.length, "chars");

await api("/api/login", { email: "boss@test.local", password: "test-pass-123" });
const st = await api("/api/staff-aliases");
const ROLE = { admin: "管理者", operator: "運營／主管", agent: "業務或訊息組" }, JOB = { chat: "訊息組（線上回訊息）", sales: "業務（到店、成交）", both: "訊息＋業務都做", manager: "管理職", "": "未設定" };
let S = "# staff.yaml —— 員工與暱稱（2026-09-09 從正式站匯出；名字＝團隊平常的叫法，其他系統裡的名字放 aliases；真名不放這裡）\n# 黎 9/9 確認：Ash＝賴安、W ♡＝小魚、SHINN＝歆語（訊息組主管）、君岳趙＝阿軒（趙君岳）；惟、筬陞、貳零貳🧊、Xm 都是業務（已建帳號）；DN德恩-孝澄 不是員工（6/14 已退出所有群組）\n# 還沒確認：「侑」是不是孜侑、「謝」是不是筬陞、「奕鴻」是不是阿木、Super 8 座位「L L」是不是 L🌵（Lorsin）、「張小恩」跟「張」是不是同一人、瑄 的職務、Uzi 是誰\n# 綠化＝AI 工程（Curry 9/9 確認），不是運營、不管車源表，不算業務或訊息組；「瑋瑋中古車」＝加好友自動回覆的發送者，不是人\n";
S += "staff:\n";
for (const u of st.staff || []) {
  if (u.role === "admin" && u.name === "老闆") continue;
  S += `  - name: ${y(u.name)}\n    role: ${u.role}   # ${ROLE[u.role] ?? ""}\n    job: ${y(u.job || "")}   # ${JOB[u.job || ""] ?? ""}\n    team: ${y(u.team || "")}\n    seat_shared: ${u.seat_shared ? "true" : "false"}\n`;
  if ((u.aliases || []).length) S += `    aliases: [${u.aliases.map((a) => y(a.alias)).join(", ")}]\n`;
}
S += "unresolved_group_names:   # 成交群／估車群／接待組出現、對不到員工\n" + ["瑄（收款／帳務？）", "Uzi"].map((n) => `  - ${y(n)}`).join("\n") + "\n";
S += "not_staff:   # 群組裡出現過但不是員工\n  - " + y("DN德恩-孝澄（成交群 2026-05-11～06-09、接待組 6/6～6/9，6/14 退出所有群組；黎 9/9 確認不是員工）") + "\n";
S += "system_senders:   # 不是人\n  - " + y("Unknown（Super 8 API：車卡、群發、未署名客服）") + "\n  - " + y("Auto-response（LINE 自動回覆）") + "\n  - " + y("瑋瑋中古車（加好友自動回覆）") + "\n";
writeFileSync(ROOT + "docs/staff.yaml", S); console.log("wrote docs/staff.yaml", (st.staff || []).length, "users");
