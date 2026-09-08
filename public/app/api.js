/* API 小工具：所有頁面共用。回傳一律 { ok, ...}，HTTP 錯誤也包成物件不丟例外。 */
/** 分析視窗的基準：預設「資料截至」（資料最後一天），可切「到今天」；存 localStorage，所有 /api 呼叫自動帶 anchor=today（一處改、全站生效） */
export const anchorMode = () => { try { return localStorage.getItem("anchor") === "today" ? "today" : "data"; } catch { return "data"; } };
export const setAnchorMode = (m) => { try { if (m === "today") localStorage.setItem("anchor", "today"); else localStorage.removeItem("anchor"); } catch { /* 無痕模式 */ } };
export async function api(path, body, method) {
  if (path.startsWith("/api/") && anchorMode() === "today") path += (path.includes("?") ? "&" : "?") + "anchor=today";
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
  me.user.data_end = me.data_end ?? null;   // 資料末端（null＝資料到現在），頂欄與各頁「資料截至」用
  return me.user;
}

export async function switchUser(email) {
  const j = await api("/api/demo-login", { email });
  if (j.ok) location.reload();
}
