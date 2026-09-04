/**
 * 漏斗引擎準確率：拿引擎偵測到的事件對模擬器的標準答案（data/mock/truth.json）。
 *   node scripts/eval_funnel.mjs [base_url]
 * 每種事件算 precision / recall；門檻見 docs/FUNNEL_MODEL.md。沒過就列出漏抓/誤抓的 lead 讓人去看。
 */
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8788";
const ADMIN = { email: "boss@test.local", password: "test-pass-123" };
const THRESH = { PRICE_DROP_OFF: { p: 0.85, r: 0.9 }, default: { p: 0.8, r: 0.8 } };
// 這些事件的「標準答案」跟偵測定義不完全一樣（例如 CUSTOMER_INACTIVE 取決於 now），只報告不計分
const REPORT_ONLY = new Set(["CUSTOMER_INACTIVE", "FOLLOW_UP", "RE_ENGAGED", "HIGH_INTENT"]);

let cookie = "";
async function api(path, body, method) {
  const r = await fetch(BASE + path, { method: method || (body ? "POST" : "GET"), headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return r.json();
}

const l = await api("/api/login", ADMIN); if (!l.ok) { console.error("登入失敗"); process.exit(1); }
const run = await api("/api/admin/funnel/run", { now: "2026-09-04T12:00:00Z" });   // 跟模擬器的 NOW 對齊
console.log(`引擎跑完：${run.leads} 個 lead、${run.events} 個事件、${run.ms} ms`);
const { events, stages } = await api("/api/admin/funnel/events");
console.log("階段分布：", Object.fromEntries(stages.map((s) => [s.stage, s.n])));

const truth = JSON.parse(readFileSync("data/mock/truth.json", "utf8"));
// conv_key CV{n} ↔ lead_key L{n}
const detected = new Map(), inferred = new Map();
for (const e of events) {
  const k = String(e.conv_key || "").replace(/^CV/, "L");
  let d = {}; try { d = JSON.parse(e.detail || "{}"); } catch {}
  if (!detected.has(k)) detected.set(k, new Set());
  // 推定事件（例如沉默 21 天→推定流失）是預測不是事實，分開評，不計入 precision/recall
  if (d.inferred) { if (!inferred.has(k)) inferred.set(k, new Set()); inferred.get(k).add(e.type); continue; }
  if (e.confidence !== "UNCLEAR") detected.get(k).add(e.type);
}

const types = [...new Set(truth.flatMap((t) => t.expect_events))].sort();
const rows = []; let failed = 0;
for (const type of types) {
  let tp = 0, fp = 0, fn = 0; const missed = [], extra = [];
  for (const t of truth) {
    const exp = t.expect_events.includes(type), got = detected.get(t.lead_key)?.has(type) ?? false;
    if (exp && got) tp++; else if (!exp && got) { fp++; extra.push(t.lead_key); } else if (exp && !got) { fn++; missed.push(t.lead_key); }
  }
  const p = tp + fp ? tp / (tp + fp) : 1, r = tp + fn ? tp / (tp + fn) : 1;
  const th = THRESH[type] || THRESH.default; const ok = REPORT_ONLY.has(type) ? null : (p >= th.p && r >= th.r);
  if (ok === false) failed++;
  rows.push({ type, tp, fp, fn, precision: p.toFixed(2), recall: r.toFixed(2), verdict: ok === null ? "報告" : ok ? "✓" : "✗", missed: missed.slice(0, 4).join(" "), extra: extra.slice(0, 4).join(" ") });
}
console.table(rows);

// 價格後流失的專屬對照：truth.price_dropoff 布林
const pd = truth.filter((t) => t.price_dropoff), got = truth.filter((t) => detected.get(t.lead_key)?.has("PRICE_DROP_OFF"));
const tp = pd.filter((t) => detected.get(t.lead_key)?.has("PRICE_DROP_OFF")).length;
console.log(`\n價格後流失：標準答案 ${pd.length}、偵測 ${got.length}、命中 ${tp} → precision ${(tp / (got.length || 1)).toFixed(2)} recall ${(tp / (pd.length || 1)).toFixed(2)}`);
// 推定流失：沉默 21 天以上的 lead，最後真的流失的比例（這個數字本身就是 CEO 簡報的素材）
const infLost = truth.filter((t) => inferred.get(t.lead_key)?.has("LOST"));
const infHit = infLost.filter((t) => t.expect_events.includes("LOST")).length;
if (infLost.length) console.log(`推定流失（沉默 ≥21 天）：${infLost.length} 個 lead，標準答案為流失 ${infHit}、仍開放 ${infLost.length - infHit} → 推定命中率 ${(infHit / infLost.length).toFixed(2)}`);
console.log(failed ? `\n✗ ${failed} 種事件沒過門檻` : "\n✓ 全部過門檻");
process.exit(failed ? 1 : 0);
