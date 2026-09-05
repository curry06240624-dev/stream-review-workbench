/**
 * 貼文解析器的固定測試：用 9/5 黎與綠化給的三種真實格式（去識別化後的樣子）跑一遍。
 *   node scripts/test_posts.ts
 */
import { parseDealReport, parseAppraisal, parseReception, parseLineExport, detectKind, parseMoney, normalizePlate, modelLike } from "../src/engine/posts.ts";

let failed = 0;
const eq = (name: string, got: unknown, exp: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) { failed++; console.log(`✗ ${name}: 得 ${JSON.stringify(got)} 應 ${JSON.stringify(exp)}`); } else console.log(`✓ ${name}`); };

/* ① 成交群「送貨囉」（火箭 17:48 的格式） */
const DEAL = `送貨囉❤️🔥❤️🔥

年份：2016
車型：c300
顏色：白
車號：
訂金（現金or匯款）：沒有
售價：768000
同行/庫存：誠鑫
送貨單位：應該阿富
備註：過件了`;
const d = parseDealReport(DEAL)!;
eq("deal.year", d.year, 2016); eq("deal.model", d.model_text, "c300"); eq("deal.color", d.color, "白");
eq("deal.plate blank", d.plate_norm, ""); eq("deal.deposit", d.deposit, "none"); eq("deal.price", d.sale_price, 768000);
eq("deal.source", [d.source_kind, d.peer_dealer], ["peer", "誠鑫"]); eq("deal.delivery", [d.delivery_by, d.delivery_uncertain], ["阿富", true]);
eq("deal.loan", d.loan_status, "approved"); eq("deal.missing", d.missing, ["車號", "客戶", "業務"]);
eq("kind deal", detectKind(DEAL), "deal");

const DEAL2 = `送貨囉\n年份:2019\n車型:Altis\n顏色:珍珠白\n車號:ABC-1234\n訂金（現金or匯款）:匯款\n售價:52.8萬\n同行/庫存:庫存\n送貨單位:小黑\n備註:現金 不用貸\n客戶:7/26大哥\n業務:小婷`;
const d2 = parseDealReport(DEAL2)!;
eq("deal2.plate", d2.plate_norm, "ABC1234"); eq("deal2.price 萬", d2.sale_price, 528000); eq("deal2.source", d2.source_kind, "stock");
eq("deal2.deposit", d2.deposit, "transfer"); eq("deal2.loan none", d2.loan_status, "none"); eq("deal2.customer/staff", [d2.customer_ref, d2.staff_ref], ["7/26大哥", "小婷"]);
eq("deal2.missing", d2.missing, []);

/* ② 估車群（梨子 13:21 的格式） */
const APPR = `估車

車型：馬三
年份：2017
版本：低階
顏色：白
里程：9.1萬
權威：23
天書：31

車換車or純賣：車換車
客人理想價格：`;
const a = parseAppraisal(APPR)!;
eq("appr.model", a.model_text, "馬三"); eq("appr.year", a.year, 2017); eq("appr.trim", a.trim, "低階");
eq("appr.mileage", a.mileage_km, 91000); eq("appr.books", [a.book_quanwei, a.book_tianshu], [230000, 310000]);
eq("appr.mode", a.mode, "trade_in"); eq("appr.ask blank", a.customer_ask, null);
eq("kind appraisal", detectKind(APPR), "appraisal");
eq("modelLike 馬三", modelLike("馬三", "Mazda Mazda3"), true);
eq("modelLike c300", modelLike("c300", "Mercedes-Benz C300"), true);
eq("modelLike no", modelLike("c300", "Toyota Altis"), false);

/* ③ 接待群：標籤版與一行版 */
const REC = `客戶名：7/26大哥\n車款：RAV4\n到店時間：下午3點\n誰指派：小婷`;
const r = parseReception(REC, "2026-09-05T02:00:00.000Z")!;      // 台灣 10:00
eq("rec.customer", r.customer_ref, "7/26大哥"); eq("rec.model", r.model_text, "RAV4"); eq("rec.time 下午3點", r.visited_at, "2026-09-05T07:00:00.000Z"); eq("rec.staff", r.assigned_name, "小婷");
const r2 = parseReception("陳先生 Altis 14:30 阿凱", "2026-09-05T02:00:00.000Z")!;
eq("rec2 一行", [r2.customer_ref, r2.model_text, r2.visited_at, r2.assigned_name], ["陳先生", "Altis", "2026-09-05T06:30:00.000Z", "阿凱"]);
eq("kind reception", detectKind(REC), "reception");

/* ④ LINE 匯出檔（tab 分隔、多行、系統訊息） */
const EXPORT = `[LINE] 與 成交群 的聊天記錄
儲存日期：2026/09/05 18:00

2026.09.04 星期五
17:48\t火箭\t送貨囉❤️🔥
年份：2016
車型：c300
售價：768000
18:02\t瑋瑋\t好
2026.09.05 星期六
12:34\t瑋瑋\t瑋瑋已新增綠化至群組。
13:21\t梨子\t估車
車型：馬三
年份：2017`;
const posts = parseLineExport(EXPORT);
eq("export count", posts.length, 3);
eq("export first at", posts[0]!.at, "2026-09-04T09:48:00.000Z");
eq("export multiline", posts[0]!.text.split("\n").length, 4);
eq("export sender", posts[2]!.sender, "梨子");
eq("export kinds", posts.map((p) => detectKind(p.text)), ["deal", "unknown", "appraisal"]);

/* ⑤ 小工具 */
eq("money 76萬8", parseMoney("76萬8"), 768000); eq("money 1,200,000", parseMoney("1,200,000"), 1200000); eq("money 23 小數視萬", parseMoney("23", 1000), 230000);
eq("plate 無", normalizePlate("無"), ""); eq("plate 全形", normalizePlate("ＡＢＣ－１２３４"), "ABC1234");

console.log(failed ? `\n✗ ${failed} 項失敗` : "\n✓ 解析器全部通過");
process.exit(failed ? 1 : 0);
