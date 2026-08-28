/**
 * Prompt 品質自測 —— 打真的 Gemini，不用 mock。
 *
 * 合格標準（DEMO_PLAN 訂的，不是感覺）：
 *   A 場（故意埋 3 個問題：冷場 8 分鐘、報價含糊、沒有行動呼籲）
 *     → AI 至少抓到 2/3，且每條引用都通過逐字核對
 *   B 場（正常場）→ 不硬湊問題（0–1 個可接受），引用全部核對通過
 *
 * 跑法：node scripts/test_prompt.mjs   （吃環境變數 GEMINI_API_KEY）
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("需要 GEMINI_API_KEY"); process.exit(2); }

// 跟 src/gemini.js 同一份 prompt 與核對邏輯 —— 從原始碼抽出來，不複製第二份
const src = readFileSync(join(HERE, "../src/gemini.js"), "utf8");
const PROMPT = src.match(/const PROMPT = `([\s\S]*?)`;/)[1];
const squash = (s) => String(s || "").replace(/[\s　]+/g, "");
const verifyQuote = (t, q) => squash(q).length >= 4 && squash(t).includes(squash(q));

async function review(transcript, metrics) {
  const prompt = PROMPT
    .replace("{{METRICS}}", JSON.stringify(metrics, null, 2))
    .replace("{{TRANSCRIPT}}", transcript);
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" } }) });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return JSON.parse(d.candidates[0].content.parts[0].text);
}

// 埋的三個問題，各自的偵測關鍵詞（AI 措辭會變，抓概念不抓字面）
const PLANTED = [
  { name: "冷場約 8 分鐘", kw: ["冷場", "空白", "離開", "中斷", "沒有說話", "停播", "空窗", "消失"] },
  { name: "報價含糊帶過", kw: ["價格", "報價", "私訊", "不透明", "沒有公開", "不講", "含糊"] },
  { name: "沒有行動呼籲", kw: ["行動呼籲", "CTA", "下一步", "導流", "預約", "留資", "轉換", "收單", "結尾"] },
];

const A = readFileSync(join(HERE, "../data/fake_A_問題場.txt"), "utf8");
const B = readFileSync(join(HERE, "../data/fake_B_正常場.txt"), "utf8");

let fail = 0;
const chk = (label, ok, detail = "") => {
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "　" + detail : ""}`);
  if (!ok) fail++;
};

console.log(`模型：${MODEL}\n`);
console.log("【A 場｜故意埋 3 個問題】");
const ra = await review(A, { viewers_total: 1800, peak_viewers: 95, comments: 41, inquiries: 2 });
for (const p of ra.problems || []) {
  const v = verifyQuote(A, p.quote);
  console.log(`   ・[${v ? "引用OK" : "引用對不上"}] ${p.text.slice(0, 60)}`);
  console.log(`     「${String(p.quote).slice(0, 50)}」（${p.pos || "?"}）`);
}
const hitList = PLANTED.map((pl) => ({
  ...pl,
  hit: (ra.problems || []).some((p) => pl.kw.some((k) => (p.text + p.quote).includes(k))),
}));
for (const h of hitList) console.log(`   埋點「${h.name}」被抓到：${h.hit ? "是" : "否"}`);
const hits = hitList.filter((h) => h.hit).length;
chk(`埋 3 抓到 ${hits}（標準 ≥2）`, hits >= 2);
chk("A 場至少 2 條被評為「重大」",
  (ra.problems || []).filter((p) => p.severity === "重大").length >= 2,
  (ra.problems || []).map((p) => p.severity).join("/"));
chk("A 場引用全部逐字核對通過",
  (ra.problems || []).every((p) => verifyQuote(A, p.quote)),
  `${(ra.problems || []).filter((p) => !verifyQuote(A, p.quote)).length} 條沒過`);
chk("每個任務都有可檢驗標準",
  (ra.actions || []).length > 0 && (ra.actions || []).every((a) => (a.success_criteria || "").length >= 6));

console.log("\n【B 場｜正常場，不准硬湊】");
const rb = await review(B, { viewers_total: 2600, peak_viewers: 210, comments: 87, inquiries: 9 });
for (const p of rb.problems || []) console.log(`   ・${p.text.slice(0, 66)}`);
chk(`B 場沒有任何「重大」問題（教練級建議可以有，事故級不該有）`,
  (rb.problems || []).every((p) => p.severity !== "重大"),
  (rb.problems || []).map((p) => p.severity).join("/") || "(無)");
chk("B 場引用全部核對通過", (rb.problems || []).every((p) => verifyQuote(B, p.quote)));
console.log(`   notes：${(rb.notes || "").slice(0, 80)}`);

console.log(`\n${fail === 0 ? "全部通過" : `失敗 ${fail} 項 —— 改 prompt，不改標準`}`);
process.exit(fail ? 1 : 0);
