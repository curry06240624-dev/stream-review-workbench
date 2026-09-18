/* 元件與格式化：每一頁都只用這裡的東西，六頁才會長得像同一個產品。 */

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const h = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? (vals[i] instanceof Raw ? vals[i].s : esc(vals[i])) : ""), "");
class Raw { constructor(s) { this.s = s; } }
export const raw = (s) => new Raw(s);

/* ── 數字 ── */
export const pct = (x, digits = 0) => (x == null || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(digits)}%`);
export const nt = (n) => (n == null ? "—" : "NT$ " + Math.round(n).toLocaleString("zh-TW"));
export const wan = (n) => (n == null ? "—" : `${Math.round(n / 10000).toLocaleString("zh-TW")} 萬`);
export const num = (n) => (n == null ? "—" : Number(n).toLocaleString("zh-TW"));
const TZ = 8 * 3600000;
export const tw = (iso) => { const d = new Date(Date.parse(iso) + TZ); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: String(d.getUTCHours()).padStart(2, "0"), mm: String(d.getUTCMinutes()).padStart(2, "0"), dow: "日一二三四五六"[d.getUTCDay()] }; };
export const fmtDT = (iso) => { if (!iso) return "—"; const t = tw(iso); return `${t.m}/${String(t.d).padStart(2, "0")} ${t.hh}:${t.mm}`; };
export const fmtD = (iso) => { if (!iso) return "—"; const t = tw(iso); return `${t.m}/${String(t.d).padStart(2, "0")}`; };
export const ago = (iso, now = Date.now()) => { if (!iso) return "—"; const m = Math.round((now - Date.parse(iso)) / 60000); if (m < 0) return fmtD(iso); if (m < 60) return `${m} 分`; const hh = Math.round(m / 60); if (hh < 48) return `${hh} 小時`; return `${Math.round(hh / 24)} 天`; };

/** 差異箭頭：正向保持中性（灰綠），只有「壞方向」才用琥珀。goodIsUp 表示數字變大是好事 */
export function delta(cur, prev, { goodIsUp = true, fmt = pct } = {}) {
  if (window.__fixedPeriod) return "";   // 只有一個月資料的站沒有「前期」可比，箭頭一律不畫
  if (cur == null || prev == null) return h`<span class="delta">—</span>`;
  const d = cur - prev; if (Math.abs(d) < 1e-9) return h`<span class="delta">持平</span>`;
  const good = goodIsUp ? d > 0 : d < 0;
  const arrow = d > 0 ? "↑" : "↓";
  const txt = fmt === pct ? `${(Math.abs(d) * 100).toFixed(0)} 點` : fmt(Math.abs(d));
  return h`<span class="delta ${good ? "up" : "bad"}">${arrow} ${txt}</span>`;
}

/* ── chip ── */
export const CONF = { CONFIRMED: "確定", STRONGLY_SUGGESTED: "強烈建議", POSSIBLE: "可能", UNCLEAR: "不確定" };
export const CLAIM = { fact: "事實", correlation: "相關", hypothesis: "假設" };
export const SEV = { critical: "緊急", high: "高", medium: "中", low: "低" };
export const STAGE = { new: "新進線", interest: "車款興趣", discussion: "有來有往", price: "報價", appointment: "預約", visit: "到店", negotiation: "議價", closed: "結案" };
export const EVENT = {
  NEW_LEAD: "新進線", VEHICLE_INTEREST: "車款興趣", ACTIVE_DISCUSSION: "有來有往", PRICE_MENTIONED: "報價", PRICE_OBJECTION: "價格異議",
  PRICE_DROP_OFF: "價格後流失", FINANCING_QUESTION: "貸款詢問", APPOINTMENT_PROPOSED: "提議看車", APPOINTMENT_BOOKED: "預約成立",
  APPOINTMENT_CHANGED: "改期", APPOINTMENT_CANCELLED: "取消預約", NO_SHOW: "爽約", STORE_VISIT: "到店", NEGOTIATION: "議價",
  FOLLOW_UP: "業務跟進", HIGH_INTENT: "高意圖", CUSTOMER_INACTIVE: "客戶沉默", RE_ENGAGED: "回流", SOLD: "成交", LOST: "流失",
};
export const LOST_REASON = { no_response: "沒有回應", price: "價格", financing: "貸款沒過", changed_mind: "改變主意", bought_elsewhere: "別家買了", vehicle: "車況／車款", unknown: "未標記" };
export const BODY_TYPE = { suv: "休旅", sedan: "轎車", hatch: "掀背", mpv: "MPV", pickup: "皮卡", wagon: "旅行車", coupe: "跑車" };
export const lostReason = (r) => LOST_REASON[r] || r || "未標記";
export const bodyType = (b) => BODY_TYPE[b] || b || "未分類";
export const chipConf = (c) => h`<span class="chip conf-${c}">${CONF[c] || c}</span>`;
export const chipClaim = (c) => h`<span class="chip claim-${c}">${CLAIM[c] || c}</span>`;
export const chipStage = (s) => h`<span class="chip stage">${STAGE[s] || s}</span>`;
export const chip = (text, cls = "") => h`<span class="chip ${cls}">${text}</span>`;
/** 統計小卡（漏斗頁／成交頁各有一份本地版；總覽用這個） */
export const stat = (label, value, extra = "", cls = "") => `<div class="stat ${cls}"><div class="l">${esc(label)}</div><b>${value}</b>${extra ? `<div class="d">${extra}</div>` : ""}</div>`;
/** SABC（公司訊息組的分級，系統推算版；docs/SABC_RULES.md） */
export const GRADE = { S: "S 高推進", A: "A 資料齊", B: "B 對談中", C: "C 未對談" };
export const chipGrade = (g, reason = "") => (g ? h`<span class="chip ${g === "S" ? "amber" : g === "A" ? "ok" : ""}" title="${reason}">${g}</span>` : "");

/* ── 頁首（每頁一句 AI）── */
export const pageHead = (title, aiLine, right = "") => h`<div class="ph"><h1>${title}</h1>${aiLine ? raw(h`<div class="ai">${aiLine}</div>`) : ""}<span class="sp"></span>${raw(right)}</div>`;

/* ── 洞察卡 ── */
export function insightCard(i, { selected = false } = {}) {
  const n = i.metric && i.metric.n != null ? `n=${i.metric.n}` : "";
  return h`<div class="card ${i.severity} ${selected ? "sel" : ""}" data-id="${i.id}">
    <div class="t"><span class="dot"></span><span>${i.title}</span></div>
    <div class="meta">${raw(chipConf(i.confidence))} ${raw(chipClaim(i.claim))} <span>${n}</span>${i.leads_n ? raw(h`<span>· ${i.leads_n} 位</span>`) : ""}</div>
    <div class="go"><a href="/insights/${i.id}" data-link>查看證據 ›</a></div>
  </div>`;
}

/* ── KPI 小格（含 sparkline）── */
export function kpi(label, value, deltaHtml, series) {
  const id = "sp" + Math.random().toString(36).slice(2, 8);
  queueMicrotask(() => sparkline(id, series || []));
  return h`<div class="kpi"><div class="l">${label}</div><b>${value}</b><div class="d">${raw(deltaHtml || "")}</div><canvas id="${id}" width="96" height="34"></canvas></div>`;
}
export function sparkline(id, series) {
  const c = document.getElementById(id); if (!c || !series.length) return;
  const ctx = c.getContext("2d"); const W = c.width, H = c.height;
  const mx = Math.max(...series), mn = Math.min(...series), rg = mx - mn || 1;
  ctx.clearRect(0, 0, W, H); ctx.beginPath();
  series.forEach((v, i) => { const x = (i / (series.length - 1 || 1)) * (W - 2) + 1, y = H - 3 - ((v - mn) / rg) * (H - 8); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = "rgba(154,166,180,.9)"; ctx.lineWidth = 1.5; ctx.stroke();
  const lx = W - 1, ly = H - 3 - ((series[series.length - 1] - mn) / rg) * (H - 8);
  ctx.fillStyle = "#4FD1E5"; ctx.beginPath(); ctx.arc(lx, ly, 2.2, 0, Math.PI * 2); ctx.fill();
}

/* ── 漏斗條 ── */
export function funnelStrip(stages, { slim = false, bottleneck = null } = {}) {
  return h`<div class="funnel ${slim ? "slim" : ""}">${raw(stages.map((s, i) => h`${i ? raw('<span class="arrow">→</span>') : ""}<div class="st ${s.key === bottleneck ? "bottleneck" : ""}">
      <div class="l"><span>${s.label}</span>${s.conv != null ? raw(h`<span>${pct(s.conv)}</span>`) : ""}</div>
      <div class="n num">${num(s.n)}</div>
      <div class="r">${s.delta ? raw(s.delta) : ""}${s.drop != null ? raw(h`<span>流失 ${pct(s.drop)}</span>`) : ""}</div>
      ${s.href ? raw(h`<a href="${s.href}" data-link aria-label="${s.label}"></a>`) : ""}
    </div>`).join(""))}</div>`;
}

/* ── 表格 ── */
export function table(cols, rows, { rowHref, dense = false, empty = "沒有資料" } = {}) {
  if (!rows.length) return h`<div class="empty">${empty}</div>`;
  const head = cols.map((c) => h`<th class="${c.num ? "num" : ""}">${c.label}</th>`).join("");
  const body = rows.map((r) => {
    const href = rowHref ? rowHref(r) : null;
    const tds = cols.map((c) => { const v = c.render ? c.render(r) : esc(r[c.key]); const cls = [c.num ? "num" : "", c.cls ? c.cls(r) : ""].join(" "); return `<td class="${cls}">${v}</td>`; }).join("");
    return `<tr class="${href ? "row" : ""}" ${href ? `data-href="${esc(href)}"` : ""}>${tds}</tr>`;
  }).join("");
  return `<table class="tbl ${dense ? "dense" : ""}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ── 對話訊息 ── */
export function bubble(m, { evidence = null } = {}) {
  const who = m.sender_role === "customer" ? "客戶" : (m.staff_name ? `業務 ${m.staff_name}` : "業務");
  return h`<div class="msg ${m.sender_role} ${evidence ? "ev" : ""}" id="m${m.id}">
    <div class="who">${who} · ${fmtDT(m.created_at)}</div>
    <div class="b">${m.text}</div>
    ${evidence ? raw(h`<span class="note">${evidence}</span>`) : ""}
  </div>`;
}
export function eventMark(e) {
  const cls = e.type === "PRICE_DROP_OFF" || e.type === "NO_SHOW" || e.type === "LOST" ? "amber" : "";
  return h`<div class="evmark ${cls}" id="e${e.id}"><span class="tag">${EVENT[e.type] || e.type}</span><span>·</span><span>${CONF[e.confidence] || e.confidence}</span>${e.source === "ledger" ? raw('<span class="faint">· 帳本</span>') : ""}</div>`;
}

/* ── 雜項 ── */
export function toast(msg) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2400); }
export function bindRows(root) { root.querySelectorAll("tr[data-href]").forEach((tr) => tr.addEventListener("click", () => window.__nav(tr.dataset.href))); }
/** 期間視窗的基準（跟 router.js 的切換鈕同一個狀態）：預設資料截至，可切到今天 */
/** 期間文字：一般站「最近 N 天 · 對照前 N 天」；只有一個月資料的站（window.__fixedPeriod）＝「整個 8 月」 */
export const periodLabel = (days, compare = true) => { const f = window.__fixedPeriod; return f ? f.label : `最近 ${days} 天${compare ? ` · 對照前 ${days} 天` : ""}`; };
export const anchorNote = () => { const f = window.__fixedPeriod; if (f) return `${f.label}（${f.range}）`; let mode = "data"; try { mode = localStorage.getItem("anchor") === "today" ? "today" : "data"; } catch { /* 無痕 */ } const de = window.__dataEnd; return mode === "today" ? "到今天" : de ? `資料截至 ${fmtDT(de)}` : "資料到現在"; };
export const periodSeg = (days, onChange) => { const f = window.__fixedPeriod; if (f) return h`<div class="seg"><button class="on" title="${f.range}">${f.label}</button></div><span class="faint" style="margin-left:8px;font-size:12px;white-space:nowrap">${f.range}</span>`; const id = "seg" + Math.random().toString(36).slice(2, 7); queueMicrotask(() => { document.getElementById(id)?.querySelectorAll("button").forEach((b) => b.onclick = () => onChange(Number(b.dataset.d))); }); return h`<div class="seg" id="${id}">${raw([7, 14, 30].map((d) => h`<button class="${d === days ? "on" : ""}" data-d="${d}">${d} 天</button>`).join(""))}</div><span class="faint" style="margin-left:8px;font-size:12px;white-space:nowrap">${anchorNote()}</span>`; };

/* ── Chart.js 共用外觀：灰＝中性、琥珀＝警示、青＝系統強調；只在有用的時候畫圖 ── */
export const chartOpts = () => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: "#9AA6B4", boxWidth: 10, boxHeight: 10, font: { size: 11 } } }, tooltip: { backgroundColor: "#141A24", borderColor: "#223042", borderWidth: 1, titleColor: "#E8ECF1", bodyColor: "#E8ECF1" } },
  scales: { x: { ticks: { color: "#9AA6B4", font: { size: 11 } }, grid: { color: "rgba(34,48,66,.7)" } }, y: { beginAtZero: true, ticks: { color: "#9AA6B4", font: { size: 11 }, precision: 0 }, grid: { color: "rgba(34,48,66,.7)" } } },
});
const TONE = { neutral: ["rgba(154,166,180,.32)", "#9AA6B4"], warn: ["rgba(233,164,69,.35)", "#E9A445"], accent: ["rgba(79,209,229,.32)", "#4FD1E5"] };
/** chart = { type:"bar"|"line", labels:[], series:[{ label, data, style?:"bar"|"line", tone?:"neutral"|"warn"|"accent" }] } */
export function drawChart(cv, chart) {
  if (!cv || !chart || !window.Chart) return null;
  const datasets = chart.series.map((s, i) => {
    const [bg, line] = TONE[s.tone || (i ? "accent" : "neutral")];
    const style = s.style || chart.type || "bar";
    return style === "line"
      ? { type: "line", label: s.label, data: s.data, borderColor: line, backgroundColor: line, tension: .3, pointRadius: 2.5, borderWidth: 1.5, order: 1 }
      : { type: "bar", label: s.label, data: s.data, backgroundColor: bg, borderWidth: 0, order: 2, maxBarThickness: 28 };
  });
  return new Chart(cv, { type: chart.type || "bar", data: { labels: chart.labels, datasets }, options: chartOpts() });
}

/* ── 員工效能／決策中心／流失原因 共用 ── */
export const FEAT = {
  first_response_min: { label: "首次回覆時間", unit: "min", goodIsUp: false }, median_response_min: { label: "回覆中位數", unit: "min", goodIsUp: false },
  followup_24h_rate: { label: "沉默後 24 小時內跟進", unit: "rate", goodIsUp: true }, asked_after_price: { label: "報價後接一個問題", unit: "rate", goodIsUp: true },
  objection_clarified: { label: "價格異議後先釐清", unit: "rate", goodIsUp: true }, proposed_after_intent: { label: "高意圖後主動約看車", unit: "rate", goodIsUp: true },
  fin_answered: { label: "貸款問題給具體答案", unit: "rate", goodIsUp: true }, postvisit_24h: { label: "到店後 24 小時內跟進", unit: "rate", goodIsUp: true },
  budget_clarified: { label: "開場就問預算", unit: "rate", goodIsUp: true }, opening_question: { label: "開場第一句就問問題", unit: "rate", goodIsUp: true },
  reactivated_by_staff: { label: "沉默客戶被叫回來", unit: "rate", goodIsUp: true }, escalated: { label: "找主管或同事協助", unit: "rate", goodIsUp: true },
  questions_per_msg: { label: "每則訊息的提問率", unit: "rate", goodIsUp: true }, discount_pct: { label: "成交折讓（佔定價）", unit: "pct", goodIsUp: false },
};
export const fmtMin = (v) => (v == null ? "—" : v >= 120 ? `${Math.round(v / 60)} 小時` : `${Math.round(v)} 分鐘`);
export const fmtFeat = (key, v) => { const u = FEAT[key]?.unit || "rate"; return v == null ? "—" : u === "min" ? fmtMin(v) : pct(v); };
/** 指標（比例或數值）帶樣本；沒達門檻顯示「資料不足」但仍附 k/n；不適用（訊息組沒有到店→成交）與共用帳號另外標 */
export function mval(m, fmt) {
  if (!m) return "—";
  if (m.na) return '<span class="faint">不適用</span>';
  const isRate = "rate" in m, v = isRate ? m.rate : m.value;
  const val = fmt ? fmt(v) : isRate ? pct(v) : (v == null ? "—" : num(v));
  const n = isRate ? `${m.k}/${m.n}` : `n=${m.n}`;
  if (m.shared) return `<span class="faint">共用帳號</span> <span class="ins">${n}</span>`;
  return m.ok ? `${val} <span class="ins">${n}</span>` : `<span class="faint">資料不足</span> <span class="ins">${n}</span>`;
}
/* ── 2026-09-05 真實資料流：訊息組／業務、涵蓋程度、同行車、估算毛利、配對狀態 ── */
export const JOB = { chat: "訊息組", sales: "業務", both: "業務", manager: "主管", "": "" };
export const jobChip = (job, shared) => `${job ? chip(JOB[job] || job, job === "chat" ? "cyan" : "") : ""}${shared ? ` ${chip("共用座位", "amber")}` : ""}`;
export const COVERAGE = { full: "訊息完整", partial: "涵蓋不完整", low: "幾乎只有客戶訊息" };
export const coverageChip = (c, note) => (c && c !== "full" ? `<span class="chip amber" title="${esc(note || "")}">${COVERAGE[c] || c}</span>` : "");
export const SOURCE_KIND = { stock: "庫存", peer: "同行" };
export const MATCH = { auto: "自動配對", suggested: "待確認", unmatched: "無法配對", confirmed: "已確認", rejected: "已拒絕" };
export const DEPOSIT = { cash: "現金", transfer: "匯款", none: "沒有", unknown: "未知", "": "—" };
export const LOAN = { approved: "過件", pending: "送貸中", rejected: "倒件", none: "不用貸款", "": "—" };
/** 毛利格：沒成本就寫「無成本」，車源表估算的加「估算」 */
export const gpCell = (row) => (row.gp_known === false || row.cost_source === "none" ? '<span class="faint">無成本</span>' : `${nt(row.gross_profit)}${row.gp_is_estimate ? ' <span class="chip est">估算</span>' : ""}`);
export const PRIO = { high: "緊急", medium: "中等", low: "低" };
export const prioChip = (p) => chip(PRIO[p] || p, p === "high" ? "amber" : "");
/** 一群員工的同一指標池化（比例 k/n 相加；數值取中位數） */
export function poolGroup(list, key) {
  const ms = list.map((s) => s.behaviors?.[key]).filter(Boolean);
  if (!ms.length) return { value: null, n: 0 };
  if ("rate" in ms[0]) { const k = ms.reduce((a, m) => a + m.k, 0), n = ms.reduce((a, m) => a + m.n, 0); return { value: n ? k / n : null, n }; }
  const vals = ms.map((m) => m.value).filter((v) => v != null).sort((a, b) => a - b); const mid = Math.floor(vals.length / 2);
  return { value: vals.length ? (vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2) : null, n: ms.reduce((a, m) => a + m.n, 0) };
}
export const heatStyle = (rate, flag) => { if (rate == null) return ""; const a = Math.min(0.55, 0.08 + rate * 0.6); return flag ? `background:rgba(233,164,69,${a.toFixed(2)})` : `background:rgba(154,166,180,${(a * 0.45).toFixed(2)})`; };
export const roleLabel = (r) => ({ primary: "主要業務", supporting: "支援", manager: "主管介入", handoff_from: "交出", handoff_to: "接手", reactivation: "回流貢獻", chat_handler: "訊息組" }[r] || r);
export const LOSS = { price_resistance: "價格抗拒", financing: "貸款問題", vehicle_mismatch: "車款不符", vehicle_condition: "車況疑慮", trade_in: "舊車折抵談不攏", timing: "時機未到", family: "家人決定", bought_elsewhere: "別家買了", no_stock: "無車可賣", slow_response: "業務回覆太慢", weak_followup: "跟進不足", no_show: "預約爽約", stopped_replying: "客戶停止回覆", browsing: "隨便看看", negotiation_failed: "議價破局", other: "其他", unclear: "不明／證據不足" };
export const lossLabel = (k) => LOSS[k] || k || "—";
export const DRIVER = { customer: "客戶面", process: "流程面", unclear: "不明" };
export const STAGE_TXT = { new: "新進線", interest: "車款興趣", discussion: "有來有往", price: "報價", appointment: "預約", visit: "到店", negotiation: "議價" };
