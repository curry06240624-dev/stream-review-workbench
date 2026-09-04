/**
 * 把 NormalizedBundle 匯進系統。
 *   node scripts/import_bundle.mjs [bundle.json] [base_url] [--reset]
 * 預設：data/mock/bundle.json → http://127.0.0.1:8788
 *
 * 全新資料庫（本機 wrangler dev）會先用 SETUP_CODE 建管理員；已有帳號就直接登入。
 * 密碼跟 seed_inbox.mjs 一樣：boss@test.local / test-pass-123。
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".json")) || "data/mock/bundle.json";
const BASE = args.find((a) => a.startsWith("http")) || "http://127.0.0.1:8788";
const RESET = args.includes("--reset");
const ADMIN = { email: "boss@test.local", password: "test-pass-123", name: "老闆" };
const SETUP_CODE = process.env.SETUP_CODE || readDevVar("SETUP_CODE");

function readDevVar(k) {
  try { const m = readFileSync(".dev.vars", "utf8").match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim() : ""; }
  catch { return ""; }
}

let cookie = "";
async function api(path, body, method) {
  const r = await fetch(BASE + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, ...j };
}

const me = await api("/api/me");
if (me.needsSetup) {
  const s = await api("/api/setup", { code: SETUP_CODE, ...ADMIN });
  if (!s.ok) { console.error("初始化失敗：", s.message || s.status); process.exit(1); }
  console.log("已建立管理員", ADMIN.email);
} else if (!me.user) {
  const l = await api("/api/login", ADMIN);
  if (!l.ok) { console.error("登入失敗：", l.message || l.status); process.exit(1); }
}

const bundle = JSON.parse(readFileSync(file, "utf8"));
console.log(`匯入 ${file}（${bundle.source_system}，${bundle.conversations.length} 則對話）→ ${BASE}${RESET ? "  [reset]" : ""}`);
const t0 = Date.now();
const rep = await api(`/api/admin/import${RESET ? "?reset=1" : ""}`, bundle);
if (!rep.ok) { console.error("匯入失敗：", rep.message || rep.status); process.exit(1); }
console.log(`完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("  寫入：", rep.counts);
if (Object.keys(rep.skipped || {}).length) console.log("  略過（已存在）：", rep.skipped);
if (rep.warnings?.length) console.log("  警告：", rep.warnings.slice(0, 5));
