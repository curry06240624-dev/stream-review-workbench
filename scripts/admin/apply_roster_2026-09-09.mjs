// 套用黎 9/9 確認的名單：併帳號、建缺的人、改職務、補暱稱、重新歸屬成交、暖快取。
//   node scripts/admin/apply_roster_2026-09-09.mjs <base_url> [--dry]
// 併帳號不可逆，先 --dry 看一遍再真跑。
const BASE = process.argv[2] || "https://ai-command-center.curry06240624.workers.dev"; const DRY = process.argv.includes("--dry");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
let cookie = "";
async function api(path, body, method) {
  const r = await fetch(BASE + path, { method: method || (body ? "POST" : "GET"), headers: { "content-type": "application/json", cookie, "user-agent": UA }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return r.json();
}
await api("/api/login", { email: "boss@test.local", password: "test-pass-123" });
const load = async () => { const st = await api("/api/staff-aliases"); return new Map((st.staff || []).map((u) => [u.name, u])); };
let byName = await load();
const id = (n) => { const u = byName.get(n); if (!u) throw new Error("no user " + n); return u.id; };

// 1. 併帳號（黎明講的：Ash＝賴安、W ♡＝小魚、SHINN＝歆語；黎＝黎妍宣、君岳趙＝阿軒（趙君岳）是同名同人）
//    先不併：奕鴻→阿木（鍾奕鴻，很像但她沒明講）、謝→筬陞、侑→蔡孜侑 —— 等她回
const MERGES = [["Ash", "賴安"], ["W ♡", "小魚"], ["SHINN", "歆語❁"], ["黎", "黎妍宣"], ["君岳趙", "阿軒"]];
for (const [from, to] of MERGES) {
  if (!byName.has(from)) { console.log(`skip merge ${from}（已不存在）`); continue; }
  if (DRY) { console.log(`would merge ${from} → ${to}`); continue; }
  const r = await api(`/api/members/${id(from)}/merge`, { into: id(to) });
  console.log(`merge ${from} → ${to}:`, r.ok ? JSON.stringify(r.moved) : JSON.stringify(r));
}
byName = await load();
// 2. 缺的人（黎確認是員工）：惟、筬陞
for (const n of [{ name: "惟", email: "oa-wei@pusen.local" }, { name: "筬陞", email: "oa-chengsheng@pusen.local" }]) {
  if (byName.has(n.name)) continue;
  if (DRY) { console.log("would create", n.name); continue; }
  const r = await api("/api/members", { email: n.email, password: "test-pass-123", name: n.name, role: "agent" });
  console.log("create", n.name, r.ok ? `id ${r.id}` : JSON.stringify(r));
}
byName = await load();
// 3. 職務：歆語＝訊息組主管、黎妍宣＝運營、昱孝陳＝銷售主管 → manager（不進業務排名）；惟、筬陞＝both
const JOBS = [["歆語❁", "manager"], ["黎妍宣", "manager"], ["昱孝陳", "manager"], ["惟", "both"], ["筬陞", "both"]];
for (const [n, job] of JOBS) { const u = byName.get(n); if (!u) continue; if (u.job === job) continue; if (DRY) { console.log(`would set ${n} job=${job}`); continue; } console.log(`job ${n}=${job}:`, JSON.stringify(await api(`/api/members/${u.id}`, { job }, "PATCH"))); }
// 4. 暱稱（併過來的大多已在，缺的補）
const ALIASES = [["阿軒", ["趙君岳", "趙 君岳", "君岳趙"]], ["賴安", ["Ash"]], ["小魚", ["W ♡"]], ["歆語❁", ["SHINN", "歆語"]]];
let added = 0;
for (const [n, list] of ALIASES) { const u = byName.get(n); if (!u) continue; for (const a of list) { if (u.aliases.some((x) => x.alias === a)) continue; if (DRY) { console.log(`would alias ${a} → ${n}`); continue; } const r = await api("/api/staff-aliases", { user_id: u.id, alias: a, system: "" }); if (r.ok) added++; else console.log("alias", a, JSON.stringify(r)); } }
console.log("aliases added", added);
if (!DRY) {
  console.log("restaff:", JSON.stringify(await api("/api/reconcile/restaff", {})));
  console.log("warm:", JSON.stringify(await api("/api/admin/warm", {})).slice(0, 80));
  const a = await api("/api/analytics?days=30"); console.log("30d by_staff:", (a.deals?.by_staff || []).map((s) => `${s.staff} ${s.sold}`).join(", "));
}
byName = await load();
console.log("staff now:", [...byName.values()].map((u) => `${u.id}:${u.name}(${u.job || "-"})`).join(", "));
