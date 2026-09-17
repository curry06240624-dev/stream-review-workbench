// 把 Frank 標記工具匯出的 golden CSV（s8_ 編號）＋ frank_label_map.py 產的對照表，匯進 /api/labels/import。
//   node scripts/admin/import_golden_labels.mjs <golden.csv> <map.json> <base_url> [--source=frank-golden] [--reviewer=歆語]
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const [csvPath, mapPath] = args.filter((a) => !a.startsWith("http") && !a.startsWith("--"));
const BASE = args.find((a) => a.startsWith("http")); const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).slice(k.length + 3);
if (!csvPath || !mapPath || !BASE) throw new Error("usage: import_golden_labels.mjs <golden.csv> <map.json> <base_url>");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
let cookie = "";
async function api(path, body) {
  const r = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", cookie, "user-agent": UA }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return r.json();
}
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; } else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift(); return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
// Frank 的欄位 → labels.yaml 的鍵
const KEY = { stage_grade: "grade", quote: "PRICE_MENTIONED", post_quote_lost: "PRICE_DROP_OFF", appointment_proposed: "APPOINTMENT_PROPOSED", appointment_set: "APPOINTMENT_BOOKED", urgent: "HIGH_INTENT", loan_question: "FINANCING_QUESTION", loan_answered: "financing_resolved", deal_closed: "SOLD", outcome_tags: "result_tag" };
const csv = parseCsv(readFileSync(csvPath, "utf8").replace(/^﻿/, ""));
const map = JSON.parse(readFileSync(mapPath, "utf8"));
const rows = []; const skipped = [];
for (const r of csv) {
  const m = map[r.conversation_id];
  if (!m || !m.pseudonym || m.ambiguous) { skipped.push(r.conversation_id); continue; }
  const labels = {}; for (const [k, v] of Object.entries(KEY)) if (r[k] !== undefined) labels[v] = r[k];
  rows.push({ pseudonym: m.pseudonym, external_id: r.conversation_id, labeled_at: r.labeled_at || "", note: [r.note_kind, r.note].filter(Boolean).join("：") , labels });
}
await api("/api/login", { email: "boss@test.local", password: "test-pass-123" });
const res = await api("/api/labels/import", { source: opt("source", "frank-golden"), batch: csv[0]?.batch_seed || "", reviewer: opt("reviewer", ""), rows });
console.log("import:", JSON.stringify(res), "| skipped (no map):", skipped.length, skipped.join(","));
const sum = await api("/api/labels/summary?source=" + encodeURIComponent(opt("source", "frank-golden")));
for (const s of sum.rows || []) console.log(`${s.label.padEnd(8)} n=${s.n} agree=${s.agree} disagree=${s.disagree} unsure=${s.unsure} acc=${s.accuracy == null ? "—" : Math.round(s.accuracy * 100) + "%"} P=${s.precision == null ? "—" : Math.round(s.precision * 100) + "%"} R=${s.recall == null ? "—" : Math.round(s.recall * 100) + "%"}`);
