/**
 * 員工效能／流失原因引擎的準確率：對模擬器的標準答案（data/mock/truth.json）。
 *   node scripts/eval_loss.mjs [base_url]
 * 三段：① 流失原因（主因）每類 precision / recall  ② 角色（歸因）每種角色 precision / recall  ③ 行為特徵每個鍵的命中率
 * 門檻：主因每類 p ≥ 0.8 r ≥ 0.8（樣本 ≥3 才計分）；角色 p ≥ 0.9 r ≥ 0.9；行為特徵命中率 ≥ 0.9。沒過就列出 lead 讓人去看。
 */
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8788";
const ADMIN = { email: "boss@test.local", password: "test-pass-123" };
const TH = { reason: { p: 0.8, r: 0.8, minN: 3 }, role: { p: 0.9, r: 0.9 }, behavior: 0.9 };

let cookie = "";
async function api(path, body, method) {
  const r = await fetch(BASE + path, { method: method || (body ? "POST" : "GET"), headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return r.json();
}
const f2 = (x) => (x == null ? "—" : x.toFixed(2));

const l = await api("/api/login", ADMIN); if (!l.ok) { console.error("登入失敗"); process.exit(1); }
const run = await api("/api/admin/analyze", { now: "2026-09-04T12:00:00Z" });
console.log(`分析跑完：角色 ${run.roles.roles}、行為 ${run.behaviors.leads} 個 lead、流失分析 ${run.loss.analyzed}（流失 ${run.loss.lost}／推定 ${run.loss.suspected}）、${run.ms} ms`);
const { rows, roles } = await api("/api/admin/analyze/dump");
const truth = JSON.parse(readFileSync("data/mock/truth.json", "utf8"));
const byKey = new Map(rows.map((r) => [String(r.conv_key || "").replace(/^CV/, "L"), r]));
const rolesByLead = new Map(); for (const r of roles) { if (!rolesByLead.has(r.lead_id)) rolesByLead.set(r.lead_id, []); rolesByLead.get(r.lead_id).push(r); }
let failed = 0;

/* ── ① 流失原因（只評 outcome=lost 的 lead）── */
const cats = new Map(); const wrong = [];
for (const t of truth) {
  if (!t.loss_reason) continue;
  const r = byKey.get(t.lead_key); const got = r?.primary_reason || "(none)";
  for (const k of [t.loss_reason, got]) if (!cats.has(k)) cats.set(k, { tp: 0, fp: 0, fn: 0 });
  if (got === t.loss_reason) cats.get(got).tp++;
  else { cats.get(t.loss_reason).fn++; cats.get(got).fp++; wrong.push(`${t.lead_key}(${t.scenario.slice(0, 2)}) 應 ${t.loss_reason} 得 ${got}${r?.secondary_reason ? `/副 ${r.secondary_reason}` : ""}`); }
}
const table = [];
for (const [k, c] of [...cats.entries()].sort()) {
  const n = c.tp + c.fn, p = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null, rr = n ? c.tp / n : null;
  const scored = n >= TH.reason.minN;
  const pass = !scored || (p != null && p >= TH.reason.p && rr >= TH.reason.r);
  if (!pass) failed++;
  table.push({ reason: k, n, tp: c.tp, fp: c.fp, fn: c.fn, precision: f2(p), recall: f2(rr), gate: scored ? (pass ? "✓" : "✗") : "報告" });
}
console.log("\n① 流失主因"); console.table(table);
if (wrong.length) console.log("  判錯：", wrong.slice(0, 14).join("；"), wrong.length > 14 ? `…共 ${wrong.length}` : "");

/* ── ② 角色 ── */
const rc = {}; const rwrong = [];
for (const t of truth) {
  const r = byKey.get(t.lead_key); if (!r) continue;
  const got = new Set((rolesByLead.get(r.id) ?? []).map((x) => `${x.staff}:${x.role}`));
  const exp = new Set((t.roles ?? []).map((x) => `${x.staff}:${x.role}`));
  for (const k of new Set([...got, ...exp])) {
    const role = k.split(":")[1]; rc[role] ??= { tp: 0, fp: 0, fn: 0 };
    if (got.has(k) && exp.has(k)) rc[role].tp++; else if (got.has(k)) { rc[role].fp++; rwrong.push(`${t.lead_key} 多出 ${k}`); } else { rc[role].fn++; rwrong.push(`${t.lead_key} 漏掉 ${k}`); }
  }
}
const rt = [];
for (const [role, c] of Object.entries(rc)) {
  const p = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null, rr = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null;
  const pass = p != null && p >= TH.role.p && rr >= TH.role.r; if (!pass) failed++;
  rt.push({ role, tp: c.tp, fp: c.fp, fn: c.fn, precision: f2(p), recall: f2(rr), gate: pass ? "✓" : "✗" });
}
console.log("\n② 角色（歸因）"); console.table(rt);
if (rwrong.length) console.log("  差異：", rwrong.slice(0, 12).join("；"), rwrong.length > 12 ? `…共 ${rwrong.length}` : "");

/* ── ③ 行為特徵（真值是布林；引擎值 1/0）── */
const bc = {}; const bwrong = [];
for (const t of truth) {
  const r = byKey.get(t.lead_key); if (!r) continue;
  let feats = {}; try { feats = JSON.parse(r.features || "{}"); } catch {}
  for (const [k, exp] of Object.entries(t.behaviors ?? {})) {
    bc[k] ??= { hit: 0, miss: 0, absent: 0 };
    const g = feats[k];
    if (!g || g.v == null) { bc[k].absent++; bwrong.push(`${t.lead_key} ${k} 沒算出來`); continue; }
    if ((g.v >= 1) === exp) bc[k].hit++; else { bc[k].miss++; bwrong.push(`${t.lead_key} ${k} 應 ${exp} 得 ${g.v}`); }
  }
}
const bt = [];
for (const [k, c] of Object.entries(bc)) {
  const n = c.hit + c.miss + c.absent, acc = n ? c.hit / n : null;
  const pass = acc != null && acc >= TH.behavior; if (!pass) failed++;
  bt.push({ feature: k, n, hit: c.hit, miss: c.miss, absent: c.absent, accuracy: f2(acc), gate: pass ? "✓" : "✗" });
}
console.log("\n③ 行為特徵"); console.table(bt);
if (bwrong.length) console.log("  差異：", bwrong.slice(0, 12).join("；"), bwrong.length > 12 ? `…共 ${bwrong.length}` : "");

console.log(failed ? `\n✗ ${failed} 項沒過門檻` : "\n✓ 全部過門檻");
await new Promise((r) => setTimeout(r, 150));   // 讓 stdout 與 fetch 連線收乾淨（Windows 直接 exit 會吃掉最後幾行）
process.exit(failed ? 1 : 0);
