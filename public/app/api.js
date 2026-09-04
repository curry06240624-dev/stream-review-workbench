/* API 小工具：所有頁面共用。回傳一律 { ok, ...}，HTTP 錯誤也包成物件不丟例外。 */
export async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, ...j };
}

/** 確認登入；DEMO_MODE 開著就自動用老闆身分進去（開發時不用每次打帳密）。 */
export async function ensureLogin() {
  let me = await api("/api/me");
  if (me.needsSetup) { location.href = "/setup.html"; return null; }
  if (!me.user) {
    const j = await api("/api/demo-login", { email: "boss@test.local" });
    if (j.ok) me = await api("/api/me");
  }
  if (!me.user) { location.href = "/login.html"; return null; }
  return me.user;
}

export async function switchUser(email) {
  const j = await api("/api/demo-login", { email });
  if (j.ok) location.reload();
}
