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

/* 共用側邊欄。模組順序照 Super 8 的排法，瑋瑋的人不用重學位置。 */
function renderSidebar(me, active, counts) {
  const canAll = me.role === "admin" || me.role === "operator";
  const roleTxt = me.role === "admin" ? "管理者" : me.role === "operator" ? "運營" : "訊息手";
  const nav = (href, label, ct) =>
    '<a class="nv' + (active === href ? " on" : "") + '" href="' + href + '">' + label
    + (ct != null && ct !== "" ? '<span class="ct">' + ct + "</span>" : "") + "</a>";
  const el = document.getElementById("side");
  if (!el) return;
  el.innerHTML =
    '<div class="brand"><span class="mk">◤</span>AI 指揮中心<small>COMMAND CENTER</small></div>'
    + "<nav>"
    + nav("index.html", "總覽")
    + nav("inbox.html", "訊息中心", counts ? counts.all : "")
    + nav("new.html", "AI 覆盤")
    + "</nav>"
    + '<div class="foot2"><b>' + esc(me.name || "") + "</b>"
    + roleTxt + (canAll ? "" : "・只看得到指派給你的")
    + '<div style="margin-top:9px"><a class="plain" href="#" onclick="logout();return false">登出</a></div></div>';
}
