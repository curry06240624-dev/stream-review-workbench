// 把 super8_sender_patch.py 產的 patch 分批送進 /api/admin/sender-patch。
//   node scripts/admin/apply_sender_patch.mjs <patch.json> <base_url> [--by-id] [--chunk=2000]
// 預設用 (化名, 時間, 文字) 對（跨資料庫都能用）；--by-id 只在「產 patch 的那個資料庫」上用，快很多。
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".json")); const BASE = args.find((a) => a.startsWith("http")); const BY_ID = args.includes("--by-id");
const CHUNK = Number((args.find((a) => a.startsWith("--chunk=")) || "--chunk=2000").slice(8));
if (!file || !BASE) throw new Error("usage: apply_sender_patch.mjs <patch.json> <base_url> [--by-id]");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
let cookie = "";
async function api(path, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", cookie, "user-agent": UA }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
      if (r.status >= 500 && attempt < 4) { await new Promise((res) => setTimeout(res, attempt * 5000)); continue; }
      return r.json();
    } catch (e) { if (attempt >= 4) throw e; await new Promise((res) => setTimeout(res, attempt * 5000)); }
  }
}
await api("/api/login", { email: "boss@test.local", password: "test-pass-123" });
const patch = JSON.parse(readFileSync(file, "utf8"));
console.log("patch:", JSON.stringify(patch.stats), "items", patch.items.length, BY_ID ? "(by id)" : "(by pseudonym/time/text)");
let updated = 0, notFound = 0; const unresolved = {}; const t0 = Date.now();
for (let i = 0; i < patch.items.length; i += CHUNK) {
  const items = patch.items.slice(i, i + CHUNK).map((it) => BY_ID ? { id: it.id, role: it.role, seat: it.seat, by_id: true } : { pseudonym: it.pseudonym, at: it.at, text: it.text, role: it.role, seat: it.seat });
  const r = await api("/api/admin/sender-patch", { items });
  if (!r.ok) { console.log("chunk", i, "failed:", JSON.stringify(r).slice(0, 200)); process.exit(1); }
  updated += r.updated; notFound += r.not_found || 0; for (const [k, v] of Object.entries(r.unresolved || {})) unresolved[k] = (unresolved[k] || 0) + v;
  console.log(`  ${i + items.length}/${patch.items.length} updated ${updated} not_found ${notFound} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log("done: updated", updated, "not_found", notFound, "unresolved seats", JSON.stringify(unresolved));
