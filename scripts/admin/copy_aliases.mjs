// 把一個站的員工暱稱表（staff_aliases：LINE 群暱稱、Super 8 座位名「妍宣 黎」…）、職務、共用座位，複製到另一個站。
// 暱稱表不在 bundle 裡（是 9/9 名冊與 9/16 Super 8 匯出時在正式站手動補的），新灌的站沒有它，Super 8 發送者會全掛「未署名」、群組貼文對不到人。
//   node scripts/admin/copy_aliases.mjs <from_url> <to_url> [--dry] [--no-create] [--jobs]
// 對人用名字（或對方已有的暱稱）對；對不到的人預設建一個帳號（agent，密碼 test-pass-123）。做完呼叫 /api/reconcile/restaff 重新歸屬貼文。
const args = process.argv.slice(2);
const [FROM, TO] = args.filter((a) => a.startsWith("http")); const DRY = args.includes("--dry"), NO_CREATE = args.includes("--no-create");
if (!FROM || !TO) throw new Error("usage: copy_aliases.mjs <from_url> <to_url> [--dry]");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
const mk = (base) => { let cookie = ""; return async (path, body, method) => { const r = await fetch(base + path, { method: method || (body ? "POST" : "GET"), headers: { "content-type": "application/json", cookie, "user-agent": UA }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; return r.json(); }; };
const from = mk(FROM), to = mk(TO);
const cred = { email: "boss@test.local", password: "test-pass-123" };
if (!(await from("/api/login", cred)).ok) throw new Error("from 登入失敗"); if (!(await to("/api/login", cred)).ok) throw new Error("to 登入失敗");
const src = (await from("/api/staff-aliases")).staff || [];
let dst = (await to("/api/staff-aliases")).staff || [];
const norm = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const find = (u) => dst.find((v) => norm(v.name) === norm(u.name)) || dst.find((v) => (v.aliases || []).some((a) => norm(a.alias) === norm(u.name))) || dst.find((v) => (u.aliases || []).some((a) => norm(a.alias) === norm(v.name)));
let aliases = 0, jobs = 0, created = 0, missing = [];
for (const u of src) {
  if (u.name === "老闆" || u.role === "admin") continue;
  let v = find(u);
  if (!v) {
    if (NO_CREATE || !(u.aliases || []).length) { missing.push(u.name); continue; }
    if (DRY) { console.log("would create", u.name); created++; continue; }
    const r = await to("/api/members", { email: `copied-${u.id}@pusen.local`, password: "test-pass-123", name: u.name, role: "agent" });
    if (!r.ok) { console.log("create", u.name, JSON.stringify(r)); missing.push(u.name); continue; }
    created++; dst = (await to("/api/staff-aliases")).staff || []; v = find(u); if (!v) { missing.push(u.name); continue; }
  }
  // 職務不複製：正式站沒套過黎 9/9 的名冊（歆語／黎妍宣／昱孝陳＝manager），而且併帳號前的舊帳號（Ash、W ♡、SHINN）職務會蓋掉併後的人；職務以 apply_roster 為準。--jobs 才複製
  if (args.includes("--jobs")) { const want = {}; if (u.job && u.job !== v.job) want.job = u.job; if ((u.seat_shared ? 1 : 0) !== (v.seat_shared ? 1 : 0)) want.seat_shared = u.seat_shared ? 1 : 0;
    if (Object.keys(want).length) { jobs++; if (DRY) console.log(`would set ${v.name}`, JSON.stringify(want)); else { const r = await to(`/api/members/${v.id}`, want, "PATCH"); if (!r.ok) console.log("patch", v.name, JSON.stringify(r)); } } }
  const have = new Set((v.aliases || []).map((a) => norm(a.alias)));
  for (const a of u.aliases || []) {
    if (have.has(norm(a.alias)) || norm(a.alias) === norm(v.name)) continue;
    aliases++; if (DRY) { console.log(`would alias ${a.alias}${a.system ? "@" + a.system : ""} → ${v.name}`); continue; }
    const r = await to("/api/staff-aliases", { user_id: v.id, alias: a.alias, system: a.system || "" }); if (!r.ok) console.log("alias", a.alias, "→", v.name, JSON.stringify(r)); else have.add(norm(a.alias));
  }
}
console.log(`${DRY ? "(dry) " : ""}aliases ${aliases}, job/seat updates ${jobs}, users created ${created}, unmatched users: ${missing.join("、") || "—"}`);
if (!DRY) console.log("restaff:", JSON.stringify(await to("/api/reconcile/restaff", {})).slice(0, 300));
