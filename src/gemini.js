/**
 * AI 覆盤 —— 這個產品唯一的鐵則寫在這個檔案裡：
 *
 *   每一條「問題」必附逐字稿的原文引用，而且**伺服器逐字核對**。
 *   引用對不上原文的，quote_ok = 0，畫面上明白標出來 ——
 *   運營要能一眼驗證 AI 講得對不對，「80% 可用」的驗收才有意義。
 *   我們不假裝 AI 不會唬爛；我們把唬爛變成可以被抓到的。
 *
 * 另一個設計選擇（README 也有寫）：正常的場次不硬湊三條。
 * 寧可回「本場只找到 1 個重大問題」，也不要為了湊數編兩條廢話 ——
 * 編出來的那兩條會讓運營對整個工具失去信任。
 */

const PROMPT = `你是中古車直播電商的資深營運教練。下面是一場直播的逐字稿與數據。

你的任務：
1. 找出本場「最嚴重、最影響成交」的問題，最多 3 個，按嚴重度排序。
   每個問題必須附上逐字稿的**原文引用**（一字不改地複製，含標點）、大約的時間位置，
   以及嚴重度分級：
     「重大」＝直播事故或直接造成觀眾流失／成交損失（例如長時間中斷、拒絕報價）
     「中」　＝明顯拖累轉換但不是事故
     「輕微」＝教練級的優化建議，做了更好、不做也不算錯
   分級要誠實 —— 一場表現不錯的直播，列出來的可能全部都是「輕微」，這是正常的。
   如果整場找不到 3 個值得講的問題，就列實際找到的數量，不要硬湊。
2. 給下一場的改善任務，最多 3 個，每個都要有「下一場結束就能檢驗」的具體標準
   （例如：每 10 分鐘至少一次報價；不要寫「加強互動」這種驗不了的）。
3. 問題要跟數據對得起來（例如在線人數什麼時候掉，對照那個時段講了什麼）。

嚴格輸出 JSON（不要 markdown 圍欄），格式：
{
  "problems": [{"text": "問題描述", "quote": "逐字稿原文", "pos": "大約位置如 00:41", "severity": "重大|中|輕微"}],
  "actions":  [{"text": "改善任務", "success_criteria": "下一場可檢驗的標準"}],
  "notes": "一句話總評；若問題不足 3 個，在這裡說明原因"
}

【直播數據】
{{METRICS}}

【逐字稿】
{{TRANSCRIPT}}`;

/** 空白與全形空格都拿掉再比對 —— 換行或空格差異不該讓真引用被判假 */
const squash = (s) => String(s || "").replace(/[\s　]+/g, "");

export function verifyQuote(transcript, quote) {
  const q = squash(quote);
  if (q.length < 4) return false;                 // 太短的引用沒有驗證意義
  return squash(transcript).includes(q);
}

export async function runReview(env, { transcript, metrics }) {
  const model = env.GEMINI_MODEL || "gemini-3.7-flash";
  const prompt = PROMPT
    .replace("{{METRICS}}", JSON.stringify(metrics, null, 2))
    .replace("{{TRANSCRIPT}}", transcript);

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Gemini ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
  } catch (e) {
    throw new Error("AI 回傳的不是合法 JSON：" + text.slice(0, 160));
  }

  const problems = (parsed.problems || []).slice(0, 3).map((p, i) => ({
    kind: "problem", seq: i + 1,
    ai_text: String(p.text || "").slice(0, 600),
    quote: String(p.quote || "").slice(0, 400),
    quote_pos: String(p.pos || "").slice(0, 40),
    quote_ok: verifyQuote(transcript, p.quote) ? 1 : 0,
    severity: ["重大", "中", "輕微"].includes(p.severity) ? p.severity : "中",
    success_criteria: "",
  }));
  const actions = (parsed.actions || []).slice(0, 3).map((a, i) => ({
    kind: "action", seq: i + 1,
    ai_text: String(a.text || "").slice(0, 600),
    quote: "", quote_pos: "", quote_ok: 1,        // 任務不需要引用
    severity: "",
    success_criteria: String(a.success_criteria || "").slice(0, 400),
  }));
  return { model, notes: String(parsed.notes || "").slice(0, 500), items: [...problems, ...actions] };
}
