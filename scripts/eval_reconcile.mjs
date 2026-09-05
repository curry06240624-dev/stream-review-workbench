/**
 * 送貨囉貼文配對的準確率：對模擬器的標準答案（truth.report）。
 *   node scripts/eval_reconcile.mjs [base_url]
 * 兩個門檻：
 *   ① 自動配對絕不能配錯（auto 但客戶或車對錯）：錯配 ≤ 1%
 *   ② 該自動的有自動：期望 auto 的貼文，實際 auto 且正確的比例 ≥ 0.9
 * 期望「待確認」的貼文，只要沒有錯配（auto 到別人）就算過；配對正確也算過（比預期更好）。
 */
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8788";
const ADMIN = { email: "boss@test.local", password: "test-pass-123" };
let cookie = "";
async function api(path, body, method) {
  const r = await fetch(BASE + path, { method: method || (body ? "POST" : "GET"), headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return r.json();
}
const l = await api("/api/login", ADMIN); if (!l.ok) { console.error("登入失敗"); process.exit(1); }
const { reports } = await api("/api/admin/analyze/dump");
const truth = JSON.parse(readFileSync("data/mock/truth.json", "utf8"));
const byKey = new Map(reports.map((r) => [`${r.reported_at}|${r.reported_by}`, r]));

let expAuto = 0, autoOk = 0, wrongAuto = 0, missing = 0, expSug = 0, sugOk = 0; const bad = []; const wrong = [];
const statusCount = {}; for (const r of reports) statusCount[r.match_status] = (statusCount[r.match_status] ?? 0) + 1;
for (const t of truth) {
  if (!t.report) continue;
  const r = byKey.get(`${t.report.at}|${t.report.sender}`);
  if (!r) { missing++; bad.push(`${t.lead_key} 貼文沒進系統`); continue; }
  const leadOk = r.conv_key === t.lead_key.replace(/^L/, "CV");
  const vehOk = t.report.vehicle_key == null || r.vehicle_key === t.report.vehicle_key;
  const linked = r.match_status === "auto" || r.match_status === "confirmed";
  if (linked && !(leadOk && vehOk)) { wrongAuto++; wrong.push(`${t.lead_key}(${t.scenario.slice(0, 2)}) 客戶${leadOk ? "對" : `錯→${r.conv_key}`}、車${vehOk ? "對" : `錯→${r.vehicle_key}（應 ${t.report.vehicle_key}）`}`); }
  if (t.report.expect === "auto") { expAuto++; if (linked && leadOk && vehOk) autoOk++; else if (!linked) bad.push(`${t.lead_key} 應自動卻是 ${r.match_status}（${r.match_confidence || "—"}）`); }
  else { expSug++; if (!linked || (leadOk && vehOk)) sugOk++; }
}
console.log("狀態分布：", statusCount);
console.log(`期望自動 ${expAuto}：自動且正確 ${autoOk}（${(autoOk / Math.max(1, expAuto) * 100).toFixed(0)}%）`);
console.log(`期望待確認 ${expSug}：沒有錯配 ${sugOk}`);
console.log(`錯配（自動對到錯的客戶或車）${wrongAuto} / 沒進系統 ${missing}`);
if (wrong.length) console.log("  錯配明細：", wrong.slice(0, 10).join("；"));
if (bad.length) console.log("  差異：", bad.slice(0, 12).join("；"), bad.length > 12 ? `…共 ${bad.length}` : "");
const total = expAuto + expSug;
const gate1 = wrongAuto <= Math.ceil(total * 0.01), gate2 = autoOk / Math.max(1, expAuto) >= 0.9;
console.log(gate1 && gate2 ? "\n✓ 配對過門檻" : `\n✗ ${!gate1 ? "錯配太多" : ""} ${!gate2 ? "該自動的沒自動" : ""}`);
await new Promise((r) => setTimeout(r, 150));
process.exit(gate1 && gate2 ? 0 : 1);
