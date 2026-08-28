/* 共用小工具。沒有框架 —— 這個量級用框架是負債。 */

async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let j = {};
  try { j = await r.json(); } catch (e) { j = {}; }
  return Object.assign({ status: r.status }, j);
}

/* 沒登入就丟去登入頁；needsSetup 就丟去初始化 */
async function requireLogin() {
  const me = await api("/api/me");
  if (me.needsSetup && !location.pathname.endsWith("setup.html")) {
    location.href = "setup.html"; return null;
  }
  if (!me.user && !location.pathname.endsWith("login.html") && !location.pathname.endsWith("setup.html")) {
    location.href = "login.html"; return null;
  }
  const who = document.getElementById("who");
  if (who && me.user) who.textContent = me.user.name + "（" + (me.user.role === "admin" ? "管理者" : "運營") + "）";
  return me.user;
}

function showErr(msg) {
  const el = document.getElementById("err");
  if (!el) return alert(msg);
  el.textContent = msg || "";
  el.classList.toggle("on", !!msg);
}

/* textarea 自動長高（市集那次學到的：多行內容看不到第二行等於壞掉） */
function autoGrow(el) {
  const g = () => { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 520) + "px"; };
  el.addEventListener("input", g);
  el.addEventListener("paste", () => setTimeout(g, 0));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function logout() {
  await api("/api/logout", {});
  location.href = "login.html";
}
