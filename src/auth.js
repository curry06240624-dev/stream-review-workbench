/**
 * 帳號與 session —— 從技能市集的 auth.js 移植（PBKDF2 十萬次＋HttpOnly cookie，
 * 那套本週剛通過「竄改 localStorage 假冒身分」的實測），儲存從 KV 改成 SQLite。
 *
 * 差異一處要特別講：cookie 的 Secure 旗標只在 https 下加 ——
 * 本機 wrangler dev 是 http://localhost，帶 Secure 的 cookie 瀏覽器不會回送，
 * 會變成「登入永遠不生效」這種找很久的鬼（所以依請求協定決定）。
 */

const ITER = 100000;                 // Workers 的 PBKDF2 上限就是 100000（展億那次踩過 120000 → 1101）
const SESS_DAYS = 30;
const MAX_FAIL = 8;
const FAIL_MINUTES = 15;
export const COOKIE = "srw_sess";

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const now = () => new Date().toISOString();

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password),
    "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
}

/* 逐位元組比較到底，不提早回傳（時間差會洩漏猜對了幾個位元組） */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function cookieOf(request) {
  const raw = request.headers.get("cookie") || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([A-Za-z0-9_-]+)"));
  return m ? m[1] : null;
}

export function setCookie(request, token, maxAgeSec) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/** 目前登入的使用者（含 role），沒登入回 null。順手清過期 session。 */
export async function currentUser(request, db) {
  const t = cookieOf(request);
  if (!t) return null;
  const row = await db.first(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`, t);
  if (!row) return null;
  if (row.expires_at < now()) {
    await db.run("DELETE FROM sessions WHERE token = ?", t);
    return null;
  }
  return row;
}

export async function createUser(db, { email, name, password, role }) {
  const salt = rand(16);
  const hash = await pbkdf2(password, salt, ITER);
  const r = await db.run(
    `INSERT INTO users (email, name, role, salt, hash, iter, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    email, name, role, b64(salt), b64(hash), ITER, now());
  return r.lastRowId;
}

export async function issueSession(db, userId) {
  const token = b64(rand(24)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const exp = new Date(Date.now() + SESS_DAYS * 86400000).toISOString();
  await db.run("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    token, userId, exp, now());
  return { token, maxAge: SESS_DAYS * 86400 };
}

/** 登入。回 { user } 或 { error, message }。 */
export async function login(db, email, password) {
  const fl = await db.first("SELECT count, until FROM failed_logins WHERE email = ?", email);
  if (fl && fl.count >= MAX_FAIL && fl.until && fl.until > now()) {
    return { error: "locked", message: "嘗試太多次了，請等 15 分鐘再試。" };
  }
  const u = await db.first("SELECT * FROM users WHERE email = ?", email);
  const fail = async () => {
    const until = new Date(Date.now() + FAIL_MINUTES * 60000).toISOString();
    await db.run(
      `INSERT INTO failed_logins (email, count, until) VALUES (?, 1, ?)
       ON CONFLICT(email) DO UPDATE SET count = count + 1, until = ?`, email, until, until);
    return { error: "bad_login", message: "信箱或密碼不對。" };
  };
  if (!u) {
    await pbkdf2(password, rand(16), ITER);   // 不存在也算一次，回應時間才不洩漏帳號存不存在
    return fail();
  }
  const hash = await pbkdf2(password, unb64(u.salt), u.iter);
  if (!sameBytes(new Uint8Array(hash), unb64(u.hash))) return fail();
  await db.run("DELETE FROM failed_logins WHERE email = ?", email);
  return { user: u };
}
