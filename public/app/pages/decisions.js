/* 決策中心：最重要的四個問題（人／客戶／漏斗／獲利）→ 需要決定的卡 → 管理行動中心（基準 → 現在）→ 先前行動的結果。
   卡片全部由規則產生；「建立教練行動」會存基準指標，之後自動比前後。系統不代發訊息。 */
import { api } from "../api.js";
import { esc, pct, nt, num, chip, table, bindRows, fmtD, fmtDT, prioChip, mval, fmtMin, periodSeg, toast, wan, periodLabel } from "../ui.js";
import { createAction, updateAction } from "../mgmt.js";

const KIND = { coach: "教練業務", workflow: "改流程", review_financing: "檢視貸款回覆", review_pricing: "檢視報價流程", review_process: "檢視流程", contact_leads: "聯絡客戶", document_pattern: "寫成教材", review_handoff: "檢視交接", recognize: "表揚" };
const ST = { proposed: "待核准", approved: "進行中", done: "完成", dismissed: "取消" };
const fmtVal = (snap) => { if (!snap || snap.value == null) return "—"; const k = String(snap.key || ""); if (k === "first_response") return fmtMin(snap.value); if (k === "gp" || k === "avg_gp") return nt(snap.value); if (k.startsWith("loss:")) return `${snap.value} 位`; return pct(snap.value); };

export async function render(el, ctx) {
  const days = Number(ctx.query.days || 30);
  const [d, acts, a] = await Promise.all([api(`/api/decisions?days=${days}`), api("/api/mgmt-actions"), api(`/api/analytics?days=${days}`)]);
  if (!d.ok) { el.innerHTML = `<div class="empty">${esc(d.message || "決策中心只開放給老闆與主管。")}</div>`; return; }
  const cards = d.cards || [], actions = acts.ok ? acts.actions : [];
  const open = actions.filter((x) => x.status === "approved" || x.status === "proposed"), done = actions.filter((x) => x.status === "done");

  /* ── 最重要的四個問題 ── */
  const byKind = (...kinds) => cards.find((c) => kinds.includes(c.kind));
  const people = byKind("coach") || (d.watch?.[0] ? { title: `${d.watch[0].name}：${d.watch[0].issue.text.split("（")[0]}`, why: d.watch[0].pattern, links: [{ href: `/staff/${d.watch[0].staff_id}` }] } : null);
  const customer = cards.find((c) => c.key.startsWith("loss_")) || (a.ok && a.deals.lost_reasons[0] ? { title: `本期流失 ${a.deals.lost} 台，最多是「${a.deals.lost_reasons[0].reason}」`, why: "", links: [{ href: "/loss" }] } : null);
  let funnelTile = null;
  if (a.ok) { const pairs = [["price_to_booking", "報價→預約"], ["booking_to_visit", "預約→到店"], ["visit_to_sold", "到店→成交"]].map(([k, l]) => ({ l, ...(a.conversion[k] || {}) })).filter((x) => x.n >= 8 && x.rate != null).sort((x, y) => x.rate - y.rate); const w = pairs[0]; if (w) funnelTile = { title: `${w.l} ${pct(w.rate)} 是最弱的一段`, why: `n=${w.n}，前期 ${pct(w.prev_rate)}`, links: [{ href: "/funnel" }] }; }
  const profit = byKind("review_pricing") || (a.ok ? { title: a.deals.below_cost ? `${a.deals.below_cost} 筆成交低於成本` : `毛利率 ${pct(a.deals.gp_margin)}，毛利 ${wan(a.deals.gross_profit)}`, why: a.deals.below_cost ? "先看這幾筆是讓價換成交還是車況" : "", links: [{ href: "/deals" }] } : null);
  const tile = (h, x, warn) => x ? `<a class="tile ${warn ? "warn" : ""}" href="${esc(x.links?.[0]?.href || "/decisions")}" data-link><div class="h">${h}</div><div class="t">${esc(x.title)}</div><div class="m">${esc((x.why || "").slice(0, 60))}<span class="sp"></span><span style="color:var(--cyan)">查看 ›</span></div></a>` : `<div class="tile"><div class="h">${h}</div><div class="t faint">目前沒有明顯問題</div></div>`;

  /* ── 需要決定 ── */
  const cardHtml = (c, i) => `<div class="dcard ${c.priority}" data-card="${i}">
    <div style="display:flex;gap:8px;align-items:center">${prioChip(c.priority)}${chip(KIND[c.kind] || c.kind)}${c.claim === "correlation" ? chip("關聯") : ""}</div>
    <h4>${esc(c.title)}</h4>
    <div class="r4"><div><b>為什麼重要</b>${esc(c.why)}</div><div><b>觀察到的差異</b>${esc(c.observed)}</div><div><b>建議行動</b>${esc(c.action)}</div><div><b>預期衡量</b>${esc(c.measure)}</div></div>
    <div class="btns">${c.staff_ids.length ? `<a class="btn sm" href="/staff/${c.staff_ids[0]}" data-link>查看員工</a>` : ""}${c.links.filter((l) => !(c.staff_ids.length && l.label === "查看員工")).map((l) => `<a class="btn sm" href="${esc(l.href)}" data-link>${esc(l.label)}</a>`).join("")}${c.kind !== "recognize" ? `<button class="btn sm primary" data-mk="${i}">建立${KIND[c.kind] === "教練業務" ? "教練" : ""}行動</button>` : `<button class="btn sm" data-mk="${i}">記錄表揚</button>`}</div></div>`;

  /* ── 管理行動中心 ── */
  const prog = (x) => { const p = x.progress; if (!p || !p.before) return x.metric_key ? '<span class="faint">還沒有基準</span>' : "—"; const b = fmtVal(p.before), af = p.after ? fmtVal(p.after) : "—"; return `${b} → <b>${af}</b>${p.enough ? "" : ' <span class="faint">樣本未到門檻</span>'}${p.after?.n ? ` <span class="ins">n=${p.after.n} · ${p.days_after} 天</span>` : ""}`; };
  const actCols = [
    { key: "title", label: "問題", render: (x) => `<b>${esc(x.title)}</b>${x.why ? `<div class="faint" style="font-size:12px">${esc(x.why).slice(0, 80)}</div>` : ""}` },
    { key: "staff_name", label: "對象", render: (x) => esc(x.staff_name || "團隊") }, { key: "owner_role", label: "負責人", render: (x) => ({ ceo: "老闆", manager: "主管", staff: "業務" }[x.owner_role] || x.owner_role) },
    { key: "priority", label: "優先", render: (x) => prioChip(x.priority) }, { key: "due_at", label: "期限", render: (x) => fmtD(x.due_at) },
    { key: "status", label: "狀態", render: (x) => chip(ST[x.status] || x.status, x.status === "approved" ? "cyan" : "") },
    { key: "progress", label: "前 → 後", num: true, render: prog },
    { key: "ops", label: "", render: (x) => (x.status === "approved" ? `<span class="row-actions"><button class="btn sm primary" data-st="done" data-id="${x.id}">完成</button><button class="btn sm" data-st="dismissed" data-id="${x.id}">取消</button></span>` : x.status === "done" && x.result_note ? `<span class="faint">${esc(x.result_note)}</span>` : "") },
  ];
  const doneRows = done.slice(0, 6).map((x) => `<li class="act"><span class="txt"><b>${esc(x.title)}</b> <span class="faint">${esc(x.staff_name || "團隊")} · ${fmtD(x.decided_at)}</span></span><span class="num">${prog(x)}</span>${x.progress?.delta != null ? chip(x.progress.delta > 0 ? "已改變" : "未改善") : chip("待資料")}</li>`).join("");
  const todo = cards.filter((c) => c.kind !== "recognize").slice(0, 6).map((c, i) => `<li class="act"><span>${chip(KIND[c.kind] || c.kind)}</span><span class="txt">${esc(c.action)}</span>${open.some((x) => x.title === c.title) ? chip("已建立", "cyan") : `<button class="btn sm" data-mk="${cards.indexOf(c)}">建立</button>`}</li>`).join("");

  el.innerHTML = `<div class="wrap stack">
    <div class="ph"><h1>決策中心</h1><div class="ai">${cards.length ? `今天有 ${cards.length} 個決定要做：${cards.filter((c) => c.priority === "high").length} 個緊急、${cards.filter((c) => c.priority === "medium").length} 個中等。` : "目前沒有需要你決定的事。"}</div><span class="sp"></span><span class="faint" style="margin-right:10px">${periodLabel(days, false)}</span>${periodSeg(days, (dd) => ctx.nav(`/decisions?days=${dd}`))}</div>
    <section><div class="ph" style="margin-bottom:6px"><h3 class="muted" style="margin:0;font-weight:500;letter-spacing:.06em">最重要的問題</h3></div>
      <div class="tiles">${tile("人", people, !!people)}${tile("客戶", customer, !!customer && !!customer.key)}${tile("漏斗", funnelTile, false)}${tile("獲利", profit, !!(profit && profit.key))}</div></section>
    <section><div class="ph" style="margin-bottom:6px"><h3 class="muted" style="margin:0;font-weight:500;letter-spacing:.06em">需要決定 · DECISION NEEDED</h3><span class="faint">規則產生；每張附影響人數、對照差異與衡量方式</span></div>
      ${cards.length ? `<div class="grid g3">${cards.map(cardHtml).join("")}</div>` : '<div class="panel empty">沒有待決定的事。</div>'}</section>
    <section class="panel"><h3>管理行動中心 <span class="faint" style="letter-spacing:0;font-weight:400">${open.length} 個進行中 · 前後對照＝行動建立前 30 天 vs 建立後至今</span></h3>
      ${table(actCols, open, { dense: true, empty: "還沒有進行中的行動。從上面的決策卡建立。" })}</section>
    <section class="grid g2">
      <div class="panel"><h3>先前行動的結果</h3>${doneRows ? `<ul class="acts">${doneRows}</ul>` : '<div class="empty">還沒有完成的行動。</div>'}</div>
      <div class="panel"><h3>推薦的管理動作</h3>${todo ? `<ul class="acts">${todo}</ul>` : '<div class="empty">沒有。</div>'}</div>
    </section>
  </div>`;
  bindRows(el);
  el.querySelectorAll("[data-mk]").forEach((b) => b.onclick = async () => {
    const c = cards[Number(b.dataset.mk)]; if (!c) return; b.disabled = true;
    const r = await createAction({ kind: c.kind, title: c.title, staff_id: c.staff_ids[0] ?? null, priority: c.priority, metric_key: c.metric_key, why: c.why, measure: c.measure, action: c.action, owner_role: c.kind === "recognize" ? "ceo" : "manager" });
    if (r.ok) render(el, ctx);
  });
  el.querySelectorAll("[data-st]").forEach((b) => b.onclick = async () => { b.disabled = true; const note = b.dataset.st === "done" ? (prompt("結果備註（可留空）") || "") : ""; await updateAction(b.dataset.id, { status: b.dataset.st, result_note: note }); render(el, ctx); });
}
