/**
 * 大量資料的分析流程：漏斗（分批）→ 角色／行為／流失（分批）→ 車源表成交同步 → 洞察＋AI 簡報 → 印摘要。
 *   node scripts/run_pipeline.mjs [base_url] [--batch=800] [--no-insights] [--days=7]
 * 分批是為了正式站（一個請求的 CPU 時間有上限）；本機也照這樣跑，行為一致。
 */
const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("http")) || "http://127.0.0.1:8788";
const BATCH = Number((args.find((a) => a.startsWith("--batch=")) || "--batch=800").slice(8));
const DAYS = Number((args.find((a) => a.startsWith("--days=")) || "--days=7").slice(7));
const NO_INS = args.includes("--no-insights");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36";
let cookie = "";
async function api(path, body, method) {
  const r = await fetch(BASE + path, { method: method || (body ? "POST" : "GET"), headers: { "content-type": "application/json", cookie, "user-agent": UA }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { ok: false, status: r.status, body: txt.slice(0, 300) }; }
}
const l = await api("/api/login", { email: "boss@test.local", password: "test-pass-123" });
if (!l.ok) { console.error("登入失敗", l); process.exit(1); }

async function batches(path, label) {
  let cursor = 0, n = 0, rounds = 0; const t0 = Date.now();
  for (;;) {
    const r = await api(path, { batch: BATCH, cursor });
    if (!r.ok) { console.error(`${label} 失敗`, JSON.stringify(r).slice(0, 400)); process.exit(1); }
    n += r.leads ?? r.roles?.leads ?? 0; rounds++;
    if (r.done || r.next_cursor == null) break;
    cursor = r.next_cursor;
    if (rounds % 5 === 0) console.log(`  ${label}：${n} 個 lead（${Math.round((Date.now() - t0) / 1000)}s）`);
  }
  console.log(`${label} 完成：${n} 個 lead、${rounds} 批、${Math.round((Date.now() - t0) / 1000)}s`);
}
await batches("/api/admin/funnel/run", "漏斗");
await batches("/api/admin/analyze", "分析");
const sd = await api("/api/admin/sheet-deals/sync", {}); console.log("車源表成交同步：", JSON.stringify(sd));
if (!NO_INS) { const i = await api("/api/insights/run", { days: DAYS }); console.log("洞察＋簡報：", JSON.stringify({ ok: i.ok, persisted: i.persisted, narrate: i.narrate, brief: i.brief, ms: i.ms, err: i.body })); }
const a = await api(`/api/analytics?days=${DAYS}`);
if (a.ok) {
  console.log("階段：", JSON.stringify(a.funnel?.stages));
  console.log(`本期 leads ${a.funnel?.leads}（前期 ${a.funnel?.prev_leads}）；事件：`, JSON.stringify(a.funnel?.events));
  console.log("成交：", JSON.stringify({ sold: a.deals?.sold, revenue: a.deals?.revenue, gp: a.deals?.gross_profit, undelivered: a.deals?.undelivered }));
  console.log("員工（本期 leads／首次回覆分鐘）：", (a.staff || []).filter((s) => s.leads).map((s) => `${s.name} ${s.leads}/${s.median_first_response_min ?? "—"}`).join("、"));
  console.log("需要注意：", (a.attention || []).length);
}
