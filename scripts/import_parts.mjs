/**
 * 把分批的 bundle（part-001.json …）依序匯入；第一批可以 --reset（重灌）。
 *   node scripts/import_parts.mjs <資料夾> [base_url] [--reset] [--from=3]
 * 每批一個請求；印出每批的 counts。中途斷了用 --from=N 從第 N 批續跑（同一批重跑不會重複：客戶／對話以來源鍵去重）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("http") && !a.startsWith("--"));
const BASE = args.find((a) => a.startsWith("http")) || "http://127.0.0.1:8788";
const RESET = args.includes("--reset");
const FROM = Number((args.find((a) => a.startsWith("--from=")) || "--from=1").slice(7));
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
const parts = readdirSync(dir).filter((f) => /^part-\d+\.json$/.test(f)).sort();
console.log(`${parts.length} 批，從第 ${FROM} 批開始${RESET && FROM === 1 ? "（第一批重灌）" : ""}`);
const t0 = Date.now(); const total = {};
for (let i = FROM - 1; i < parts.length; i++) {
  const b = JSON.parse(readFileSync(join(dir, parts[i]), "utf8"));
  const t1 = Date.now();
  const r = await api(`/api/admin/import${RESET && i === 0 ? "?reset=1" : ""}`, b);
  if (!r.ok) { console.error(`第 ${i + 1} 批失敗`, JSON.stringify(r).slice(0, 500)); process.exit(1); }
  for (const [k, v] of Object.entries(r.counts || {})) total[k] = (total[k] || 0) + v;
  console.log(`  ${parts[i]}：${Object.entries(r.counts || {}).map(([k, v]) => `${k} ${v}`).join("、")}（${Math.round((Date.now() - t1) / 1000)}s）${(r.warnings || []).length ? " ⚠ " + r.warnings.slice(0, 2).join("；") : ""}`);
}
console.log(`完成 ${Math.round((Date.now() - t0) / 1000)}s：`, total);
