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
  let me = await api("/api/me");
  if (me.needsSetup && !location.pathname.endsWith("setup.html")) {
    location.href = "setup.html"; return null;
  }
  /* DEMO_MODE 開著就自動用老闆身分進去 —— 開發時每次都要打帳號密碼太慢。
     要換身分看權限差別，用側邊欄下面那排切換鈕，不用登出再登入。
     正式環境不設 DEMO_MODE，這段就不會生效，一律走正常登入。 */
  if (!me.user && me.demo) {
    const j = await api("/api/demo-login", { email: "boss@test.local" });
    if (j.ok) me = await api("/api/me");
  }
  if (!me.user && !location.pathname.endsWith("login.html") && !location.pathname.endsWith("setup.html")) {
    location.href = "login.html"; return null;
  }
  const who = document.getElementById("who");
  if (who && me.user) who.textContent = me.user.name + "（" + (me.user.role === "admin" ? "管理者" : "運營") + "）";
  // demo 旗標在外層，掛到 user 上，renderSidebar 才看得到
  if (me.user && me.demo) me.user.demo = true;
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
    + nav("customers.html", "客戶中心")
    + "</nav>"
    + '<div class="foot2"><b>' + esc(me.name || "") + "</b>"
    + '<span class="roletxt">' + roleTxt + (canAll ? "" : "・只看得到指派給你的") + "</span>"
    + '<div style="margin-top:9px"><a class="plain" href="#" onclick="logout();return false">登出</a></div>'
    + (me.demo ? demoSwitcher(me) : "") + "</div>";
  el.querySelectorAll(".switcher button").forEach((b) =>
    b.addEventListener("click", () => demoSwitch(b.dataset.em)));
  el.querySelector(".swsel")?.addEventListener("change", (e) => demoSwitch(e.target.value));
}

/* Demo 用的身分切換。點一下換人，馬上看到權限差別 —— 不用登出再登入。 */
function demoSwitcher(me) {
  const R = [
    { em: "boss@test.local", n: "老闆" },
    { em: "operator@test.local", n: "阿哲" },
    { em: "agent1@test.local", n: "小婷" },
    { em: "agent2@test.local", n: "阿凱" },
  ];
  /* 用 data 屬性帶信箱，事件在 renderSidebar 綁 ——
     inline onclick 要在字串裡塞引號，寫錯一個整支 app.js 就掛（踩過）。 */
  /* 桌機用按鈕排開；手機 375 寬塞不下四顆（會被擠出畫面右邊），
     所以同時輸出一個下拉選單，用 CSS 切換顯示哪一個。 */
  return '<div class="switcher"><span class="lb">切換身分（示範用）</span>'
    + R.map((r) => '<button class="sw' + (me.name === r.n ? ' on' : '')
        + '" data-em="' + r.em + '">' + r.n + "</button>").join("")
    + '<select class="swsel" aria-label="切換身分">'
    + R.map((r) => '<option value="' + r.em + '"' + (me.name === r.n ? " selected" : "")
        + ">" + r.n + "</option>").join("")
    + "</select></div>";
}
async function demoSwitch(email) {
  const j = await api("/api/demo-login", { email });
  if (j.ok) location.reload();
}
