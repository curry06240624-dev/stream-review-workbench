/**
 * 把一個檔案丟進「資料上傳」（跟畫面上的上傳箱同一條路，會自動處理：車源表 CSV → 車輛＋成交／收訂中）。
 *   node scripts/upload_doc.mjs <檔案> [base_url] [--kind=sheet_csv] [--note=...]
 * 預設 base_url http://127.0.0.1:8788；登入用 boss@test.local / test-pass-123。
 * 同樣內容上傳過（sha 相同）就改叫 /api/documents/:id/process 重新處理。
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("http") && !a.startsWith("--"));
const BASE = args.find((a) => a.startsWith("http")) || "http://127.0.0.1:8788";
const kind = (args.find((a) => a.startsWith("--kind=")) || "--kind=auto").slice(7);
const note = (args.find((a) => a.startsWith("--note=")) || "--note=").slice(7);
if (!file) { console.error("要給檔案路徑"); process.exit(1); }

let cookie = "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36";
async function api(path, init = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { ...(init.headers || {}), cookie, "user-agent": UA } });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return r.json();
}
const l = await api("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "boss@test.local", password: "test-pass-123" }) });
if (!l.ok) { console.error("登入失敗", l); process.exit(1); }

const buf = readFileSync(file);
const fd = new FormData();
fd.append("file", new Blob([buf], { type: file.endsWith(".csv") ? "text/csv" : "application/octet-stream" }), basename(file));
fd.append("kind", kind); if (note) fd.append("note", note);
const up = await api("/api/documents", { method: "POST", body: fd });
console.log(JSON.stringify(up, null, 1).slice(0, 1500));
const first = up.results?.[0] || up.files?.[0] || (Array.isArray(up.out) ? up.out[0] : null);
const item = first || (up.id ? up : null);
if (item && item.duplicate && item.id) {
  console.log("內容一樣，重新處理 #" + item.id);
  const pr = await api(`/api/documents/${item.id}/process`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  console.log(JSON.stringify(pr, null, 1).slice(0, 1500));
}
