/* 路由：路徑 → 頁面模組。每頁 export render(el, ctx)。ctx = { params, query, me, nav }。 */
import { api, ensureLogin, switchUser, anchorMode, setAnchorMode } from "./api.js";
import { esc, fmtDT } from "./ui.js";

const ROUTES = [
  ["/overview", "overview"], ["/funnel", "funnel"], ["/attention", "attention"],
  ["/conversations", "conversations"], ["/conversations/:id", "conversations"],
  ["/insights/:id", "insight"], ["/appointments", "appointments"], ["/deals", "deals"],
  ["/staff", "staff"], ["/staff/:id", "staffProfile"], ["/decisions", "decisions"], ["/loss", "loss"], ["/reconcile", "reconcile"], ["/uploads", "uploads"],
  ["/ask", "ask"], ["/data", "data"], ["/labels", "labels"],
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
    const RL = { admin: "管理者", operator: "運營", agent: "業務" };
    const opts = (me.demoAccounts || []).filter((a) => a.email !== me.email).map((a) => `<option value="${esc(a.email)}">${esc(a.name)}（${esc(RL[a.role] || a.role)}）</option>`).join("");
    w.innerHTML += `<select id="switch"><option value="">切換示範身分…</option>${opts}</select>`;
    document.getElementById("switch").onchange = (e) => e.target.value && switchUser(e.target.value);
  }
  // 分析視窗基準：資料截至（預設）／到今天。存 localStorage，api() 自動帶；切了就重畫本頁
  window.__dataEnd = me.data_end || null; const mode = anchorMode(); const de = me.data_end ? fmtDT(me.data_end) : null;
  // 其他來源比對話晚（成交群常晚兩天）就標出來：那幾天的成交不在本期，等下次對話匯出才算
  const se = me.source_ends || {}; const later = [["成交群", se.deal_reports], ["群組", se.group_posts]].filter(([, t]) => t && me.data_end && Date.parse(t) > Date.parse(me.data_end) + 60_000);
  const laterNote = mode !== "today" && later.length ? `<br>${later.map(([k, t]) => `${k}到 ${esc(fmtDT(t))}`).join("、")}<span title="視窗以 LINE 對話的最後一天為準，這幾天的成交會在下次對話匯出後才算進本期">（不在本期）</span>` : "";
  w.innerHTML += `<div class="faint" style="margin-top:6px;font-size:12px;line-height:1.5">${mode === "today" ? "視窗：到今天" : de ? `對話資料截至 ${esc(de)}` : "資料到現在"}${de ? ` · <a href="#" id="anchorToggle" style="color:var(--cyan)">${mode === "today" ? "改看資料截至" : "改看到今天"}</a>` : ""}${laterNote}</div>`;
  const tg = document.getElementById("anchorToggle"); if (tg) tg.onclick = (e) => { e.preventDefault(); setAnchorMode(mode === "today" ? "data" : "today"); paintWho(); render(); };
}

(async () => {
  me = await ensureLogin(); if (!me) return;
  const d = await api("/api/demo-login"); me.demo = !!d.demo; me.demoAccounts = d.accounts || [];   // GET 探測：正式環境 demo=false；示範模式回現有帳號清單
  paintWho(); setupCommandBar(); await render();
})();
