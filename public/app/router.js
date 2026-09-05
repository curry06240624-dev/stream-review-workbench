/* 路由：路徑 → 頁面模組。每頁 export render(el, ctx)。ctx = { params, query, me, nav }。 */
import { api, ensureLogin, switchUser } from "./api.js";
import { esc } from "./ui.js";

const ROUTES = [
  ["/overview", "overview"], ["/funnel", "funnel"], ["/attention", "attention"],
  ["/conversations", "conversations"], ["/conversations/:id", "conversations"],
  ["/insights/:id", "insight"], ["/appointments", "appointments"], ["/deals", "deals"],
  ["/staff", "staff"], ["/staff/:id", "staffProfile"], ["/decisions", "decisions"], ["/loss", "loss"], ["/reconcile", "reconcile"], ["/uploads", "uploads"],
  ["/ask", "ask"], ["/data", "data"],
];
const PAGES = {};
let me = null;

function match(path) {
  for (const [pat, mod] of ROUTES) {
    const pp = pat.split("/"), xx = path.split("/");
    if (pp.length !== xx.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < pp.length; i++) { if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xx[i]); else if (pp[i] !== xx[i]) { ok = false; break; } }
    if (ok) return { mod, params, key: mod === "insight" ? "conversations" : mod === "staffProfile" ? "staff" : mod };
  }
  return null;
}

export async function nav(href, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", href); else history.pushState({}, "", href);
  await render();
}
window.__nav = (href) => nav(href);

async function render() {
  const url = new URL(location.href);
  let path = url.pathname.replace(/\/+$/, "") || "/overview";
  if (path === "/" || path === "/index.html") { history.replaceState({}, "", "/overview"); path = "/overview"; }
  const m = match(path);
  const view = document.getElementById("view");
  document.querySelectorAll("#nav a, .nav.bottom a").forEach((a) => a.classList.toggle("on", a.dataset.key === (m && m.key)));
  if (!m) { view.innerHTML = `<div class="empty">找不到這一頁：${esc(path)}</div>`; return; }
  view.innerHTML = '<div class="loading">載入中…</div>';
  try {
    if (!PAGES[m.mod]) PAGES[m.mod] = await import(`./pages/${m.mod}.js`);
    await PAGES[m.mod].render(view, { params: m.params, query: Object.fromEntries(url.searchParams), me, nav });
    view.scrollTop = 0;
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty">這一頁載入失敗：${esc(e.message || e)}</div>`;
  }
}

/* 站內連結攔截 */
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]"); if (!a) return;
  if (e.metaKey || e.ctrlKey || e.button !== 0) return;
  e.preventDefault(); nav(a.getAttribute("href"));
});
window.addEventListener("popstate", render);

/* 全域指令列：實體命中就跳過去，否則當問句送到「問 AI」 */
function setupCommandBar() {
  const input = document.getElementById("cmdIn"), drop = document.getElementById("cmdDrop");
  let items = [], sel = -1, timer = null;
  const paint = () => {
    if (!items.length) { drop.classList.remove("on"); drop.innerHTML = ""; return; }
    drop.innerHTML = items.map((it, i) => `<a href="${esc(it.href)}" data-link class="${i === sel ? "sel" : ""}${it.type === "ask" ? " ask" : ""}"><span class="t">${esc(it.type_label)}</span><span>${esc(it.label)}</span>${it.sub ? `<span class="faint">${esc(it.sub)}</span>` : ""}</a>`).join("");
    drop.classList.add("on");
  };
  const search = async () => {
    const q = input.value.trim();
    if (!q) { items = []; paint(); return; }
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    items = (r.ok ? r.results : []).slice(0, 7);
    items.push({ type: "ask", type_label: "問 AI", label: `「${q}」`, href: `/ask?q=${encodeURIComponent(q)}` });
    sel = 0; paint();
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 160); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, items.length - 1); paint(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
    else if (e.key === "Enter") { e.preventDefault(); const it = items[sel] || items[items.length - 1]; const q = input.value.trim(); if (it) nav(it.href); else if (q) nav(`/ask?q=${encodeURIComponent(q)}`); items = []; paint(); input.blur(); }
    else if (e.key === "Escape") { items = []; paint(); input.blur(); }
  });
  input.addEventListener("blur", () => setTimeout(() => { items = []; paint(); }, 150));
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.focus(); input.select(); } });
}

function paintWho() {
  const w = document.getElementById("who"); if (!me) return;
  const roleLabel = { admin: "管理者", operator: "運營", agent: "業務" }[me.role] || me.role;
  w.innerHTML = `<b>${esc(me.name)}</b> · ${esc(roleLabel)}`;
  if (me.demo) {
    w.innerHTML += `<select id="switch"><option value="">切換示範身分…</option><option value="boss@test.local">老闆（管理者）</option><option value="operator@test.local">阿哲（運營）</option><option value="agent1@test.local">小婷（業務）</option><option value="agent2@test.local">阿凱（業務）</option></select>`;
    document.getElementById("switch").onchange = (e) => e.target.value && switchUser(e.target.value);
  }
}

(async () => {
  me = await ensureLogin(); if (!me) return;
  const d = await api("/api/demo-login"); me.demo = !!d.demo;   // GET 探測：正式環境 demo=false
  paintWho(); setupCommandBar(); await render();
})();
