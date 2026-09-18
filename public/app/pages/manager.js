/* 主管工作台：昱孝（銷售主管）每天打開的第一頁。四塊照做事的順序排：
   ① 漏追客戶（今天要回誰、誰手上最多）→ ② 銷售卡點（哪一段掉最多、誰報價後掉最多）→ ③ 人員異常（誰低於團隊基準、建議教練什麼）→ ④ 待處理行動（核准／完成）。
   全部由現有規則現算（/api/attention、/api/analytics、/api/staff、/api/decisions、/api/mgmt-actions）；每一列點進去就是證據。系統只建議，不代發訊息。 */
import { api } from "../api.js";
import { esc, pct, chip, table, bindRows, fmtDT, ago, prioChip, periodSeg, toast, funnelStrip, fmtD, pageHead, periodLabel } from "../ui.js";
import { createAction, updateAction, metricKeyFor } from "../mgmt.js";

const KIND = { high_intent_no_followup: "急迫未跟進", price_dropoff_no_followup: "報價後未跟進", booked_but_no_visit: "預約已過未到店", financing_unresolved: "貸款未回覆" };
const ORDER = Object.keys(KIND);
const ST = { proposed: "待核准", approved: "進行中", done: "完成", dismissed: "取消" };
const ROLE = { ceo: "老闆", manager: "主管", staff: "業務" };
const PAIR = { price_to_booking: "報價→預約", booking_to_visit: "預約→到店", visit_to_sold: "到店→成交" };   // 只比相鄰兩段；報價→成交那種跨段的永遠最低，沒有資訊
const DKIND = { coach: "教練業務", workflow: "改流程", review_financing: "檢視貸款回覆", review_pricing: "檢視報價流程", review_process: "檢視流程", contact_leads: "聯絡客戶", document_pattern: "寫成教材", review_handoff: "檢視交接", recognize: "表揚" };

export async function render(el, ctx) {
  const days = Number(ctx.query.days || 30);
  const canAct = ctx.me?.role === "admin" || ctx.me?.role === "operator";
  const [at, a, s, d, m] = await Promise.all([api("/api/attention"), api(`/api/analytics?days=${days}`), api(`/api/staff?days=${days}`), api(`/api/decisions?days=${days}`), api("/api/mgmt-actions")]);
  if (!at.ok || !a.ok) { el.innerHTML = `<div class="empty">${esc(at.message || a.message || "主管工作台只開放給老闆與主管。")}</div>`; return; }
  const asOf = Date.parse(at.as_of || a.period?.to || new Date().toISOString());

  /* ── ① 漏追客戶 ── */
  const items = (at.items || []).slice().sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind) || (Date.parse(x.since) || 0) - (Date.parse(y.since) || 0));
  const urgent = at.counts.high_intent_no_followup || 0;
  const byStaff = {}; for (const x of items) { const k = x.staff || "未指派"; byStaff[k] = (byStaff[k] || 0) + 1; }
  const staffChips = Object.entries(byStaff).sort((p, q) => q[1] - p[1]).map(([n, c]) => `<a class="chip" href="${n === "未指派" ? "/attention" : `/conversations?staff=${encodeURIComponent(n)}`}" data-link>${esc(n)} ${c}</a>`).join(" ");
  const leadCols = [
    { key: "contact", label: "客戶" },
    { key: "kind", label: "狀況", render: (x) => chip(KIND[x.kind] || x.kind, x.kind === "high_intent_no_followup" ? "amber" : "") },
    { key: "staff", label: "業務", render: (x) => esc(x.staff || "未指派") }, { key: "vehicle", label: "車款" },
    { key: "since", label: "等了", num: true, render: (x) => (x.since ? ago(x.since, asOf) : "—"), cls: (x) => (x.kind === "high_intent_no_followup" ? "warn" : "") },
    { key: "reason", label: "原因" },
  ];
  const shown = items.slice(0, 12);

  /* ── ② 銷售卡點 ── */
  const ev = a.funnel.events || {};
  const stages = [
    { key: "lead", label: "新進線", n: a.funnel.leads, href: "/funnel" },
    { key: "price", label: "報價", n: ev.PRICE_MENTIONED || 0, href: "/funnel" },
    { key: "booked", label: "預約", n: ev.APPOINTMENT_BOOKED || 0, href: "/appointments" },
    { key: "visit", label: "到店", n: ev.STORE_VISIT || 0, href: "/appointments" },
    { key: "sold", label: "成交", n: a.deals.sold, href: "/deals" },
  ];
  for (let i = 1; i < stages.length; i++) stages[i].conv = stages[i - 1].n ? stages[i].n / stages[i - 1].n : null;
  const pairs = Object.entries(PAIR).map(([k, l]) => ({ k, l, ...(a.conversion[k] || {}) })).filter((x) => x.n >= 8 && x.rate != null);
  const weak = pairs.slice().sort((x, y) => x.rate - y.rate)[0] || null;
  const weakKey = weak ? { price_to_booking: "booked", booking_to_visit: "visit", visit_to_sold: "sold" }[weak.k] : null;
  const pd = a.price_dropoff || {};
  const pdStaff = (pd.by_staff || []).filter((x) => x.priced >= 5).sort((x, y) => y.dropped - x.dropped).slice(0, 6);
  const pdCols = [
    { key: "staff", label: "業務" }, { key: "priced", label: "報價", num: true }, { key: "dropped", label: "報價後流失", num: true },
    { key: "rate", label: "流失率", num: true, render: (x) => pct(x.rate), cls: (x) => (pd.rate != null && x.rate != null && x.rate >= pd.rate + 0.1 ? "warn" : "") },
  ];

  /* ── ③ 人員異常 ── */
  const watch = s.ok ? s.watch || [] : [];
  const topNames = s.ok ? (s.top || []).map((t) => t.name) : [];
  const watchCards = watch.map((w) => `<div class="pcard watch">
    <h4>${esc(w.name)} <span class="faint" style="font-weight:400;font-size:12px">${esc(w.team)} · 客戶 ${w.leads} · 成交 ${w.sold} 台</span></h4>
    <div class="why"><b style="color:var(--amber)">主要問題</b> ${esc(w.issue.text)}</div>
    <div class="why"><b>模式</b> ${esc(w.pattern)}</div>
    <div class="why"><b>建議教練</b> ${esc(w.coaching)}</div>
    <div class="foot"><span class="faint">影響 ${w.evidence.affected_leads} 位客戶</span><a href="/staff/${w.staff_id}" data-link>員工檔案 ›</a><a href="/conversations?staff=${encodeURIComponent(w.name)}&outcome=lost" data-link>支持對話 ›</a><span class="sp"></span>${canAct ? `<button class="btn sm primary" data-coach="${w.staff_id}">建立教練行動</button>` : ""}</div></div>`).join("");

  /* ── ④ 待處理行動 ── */
  const acts = m.ok ? m.actions || [] : [];
  const open = acts.filter((x) => x.status === "approved" || x.status === "proposed");
  const insightActs = at.actions || [];
  const cards = d.ok ? (d.cards || []).filter((c) => c.kind !== "recognize" && !open.some((x) => x.title === c.title)).slice(0, 4) : [];
  const actCols = [
    { key: "title", label: "行動", render: (x) => `<b>${esc(x.title)}</b>${x.action && x.action !== x.title ? `<div class="faint" style="font-size:12px">${esc(x.action).slice(0, 80)}</div>` : ""}` },
    { key: "staff_name", label: "對象", render: (x) => esc(x.staff_name || "團隊") }, { key: "owner_role", label: "負責", render: (x) => ROLE[x.owner_role] || x.owner_role },
    { key: "priority", label: "優先", render: (x) => prioChip(x.priority) }, { key: "due_at", label: "期限", render: (x) => fmtD(x.due_at) },
    { key: "status", label: "狀態", render: (x) => chip(ST[x.status] || x.status, x.status === "approved" ? "cyan" : "") },
    { key: "ops", label: "", render: (x) => (!canAct ? "" : x.status === "proposed"
      ? `<span class="row-actions"><button class="btn sm primary" data-mst="approved" data-mid="${x.id}">核准</button><button class="btn sm" data-mst="dismissed" data-mid="${x.id}">取消</button></span>`
      : `<span class="row-actions"><button class="btn sm primary" data-mst="done" data-mid="${x.id}">完成</button><button class="btn sm" data-mst="dismissed" data-mid="${x.id}">取消</button></span>`) },
  ];
  const insightRow = (x) => `<li class="act"><span>${chip(ROLE[x.owner_role] || x.owner_role)}</span><span class="txt">${esc(x.text)}${x.insight_id ? ` <a href="/insights/${x.insight_id}" data-link class="faint">#${x.insight_id} ${esc(x.insight_title || "")}</a>` : ""}</span>
    ${canAct ? (x.status === "proposed"
      ? `<span class="row-actions"><button class="btn sm primary" data-act="${x.id}" data-st="approved">核准</button><button class="btn sm" data-act="${x.id}" data-st="dismissed">駁回</button></span>`
      : `<span class="row-actions">${chip("已核准", "cyan")}<button class="btn sm primary" data-act="${x.id}" data-st="done">完成</button></span>`)
      : chip(ST[x.status] || x.status)}</li>`;
  const cardRow = (c) => `<li class="act"><span>${prioChip(c.priority)}${chip(DKIND[c.kind] || c.kind)}</span><span class="txt"><b>${esc(c.title)}</b><div class="faint" style="font-size:12px">${esc(c.action)}</div></span>${canAct ? `<button class="btn sm" data-mk="${d.cards.indexOf(c)}">建立</button>` : ""}</li>`;

  /* ── 頁首一句話 ── */
  const line = [
    items.length ? `${items.length} 位客戶漏追${urgent ? `（${urgent} 位急迫，今天要回）` : ""}` : "沒有漏追的客戶",
    weak ? `${weak.l} ${pct(weak.rate)} 是最弱的一段` : (pd.rate != null ? `報價後流失 ${pct(pd.rate)}` : ""),
    watch.length ? `${watch.length} 位人員低於團隊基準` : "沒有人明顯低於團隊基準",
    `${open.length + insightActs.length} 個行動待處理`,
  ].filter(Boolean).join("；") + "。";

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("主管工作台", line, `<span class="faint" style="margin-right:10px">卡點／人員看${periodLabel(days, false)} · 漏追固定 7 天</span>${periodSeg(days, (dd) => ctx.nav(`/manager?days=${dd}`))}`)}
    <section class="panel"><h3>① 漏追客戶 <span class="faint" style="font-weight:400;letter-spacing:0">${items.length} 位 · 以資料截至 ${fmtDT(new Date(asOf).toISOString())} 計</span><span class="sp"></span><a href="/attention" data-link style="font-weight:400;letter-spacing:0">全部與待辦 ›</a></h3>
      <section class="stats" style="margin-bottom:10px">${ORDER.map((k) => `<a class="stat ${k === "high_intent_no_followup" && (at.counts[k] || 0) ? "warn" : ""}" href="/attention?kind=${k}" data-link><div class="l">${KIND[k]}</div><b>${at.counts[k] || 0}</b></a>`).join("")}</section>
      ${items.length ? `<div class="faint" style="margin-bottom:8px;font-size:12.5px">誰手上最多：${staffChips}</div>` : ""}
      ${table(leadCols, shown, { rowHref: (x) => `/conversations/${x.lead_id}`, dense: true, empty: "目前沒有需要注意的客戶。" })}
      ${items.length > shown.length ? `<div class="faint" style="margin-top:6px;font-size:12px">只列最急的 ${shown.length} 位，其餘 ${items.length - shown.length} 位在 <a href="/attention" data-link>需要注意</a>。</div>` : ""}
    </section>
    <section class="grid g2">
      <div class="panel"><h3>② 銷售卡點 <span class="faint" style="font-weight:400;letter-spacing:0">${periodLabel(days, false)}</span><span class="sp"></span><a href="/funnel" data-link style="font-weight:400;letter-spacing:0">漏斗與價格流失 ›</a></h3>
        ${funnelStrip(stages, { slim: true, bottleneck: weakKey })}
        <div class="faint" style="font-size:12px;margin:6px 0 10px">預約／到店只算 LINE 對話裡看得到的；電話約的不在裡面。</div>
        <div class="why" style="font-size:13px;line-height:1.55;margin-bottom:10px">${weak ? `<b>最弱的一段：${esc(weak.l)} ${pct(weak.rate)}</b>（n=${weak.n}，前期 ${pct(weak.prev_rate)}）` : "各段樣本還不夠比，先看報價後流失。"}</div>
        <h4 style="margin:0 0 6px;font-size:13.5px">報價後流失 ${pct(pd.rate)} <span class="faint" style="font-weight:400">${pd.count ?? 0}/${pd.base ?? 0} 位 · 前期 ${pct(pd.prev_rate)} · 團隊平均以上 10 點標記</span></h4>
        ${table(pdCols, pdStaff, { rowHref: (x) => `/conversations?staff=${encodeURIComponent(x.staff)}&outcome=lost`, dense: true, empty: "本期沒有足夠的報價紀錄。" })}
      </div>
      <div class="panel"><h3>③ 人員異常 <span class="faint" style="font-weight:400;letter-spacing:0">${watch.length} 位低於團隊基準</span><span class="sp"></span><a href="/staff" data-link style="font-weight:400;letter-spacing:0">員工效能 ›</a></h3>
        ${topNames.length ? `<div class="faint" style="font-size:12.5px;margin-bottom:8px">表現最佳：${esc(topNames.join("、"))}</div>` : ""}
        ${s.ok ? (watch.length ? `<div class="stack">${watchCards}</div>` : '<div class="empty">目前沒有人明確低於團隊基準。</div>') : `<div class="empty">${esc(s.message || "讀不到員工效能。")}</div>`}
      </div>
    </section>
    <section class="grid g2">
      <div class="panel"><h3>④ 待處理行動 <span class="faint" style="font-weight:400;letter-spacing:0">${open.length} 個管理行動 · ${insightActs.length} 條洞察待辦</span><span class="sp"></span><a href="/decisions" data-link style="font-weight:400;letter-spacing:0">決策中心 ›</a></h3>
        ${table(actCols, open, { dense: true, empty: "沒有進行中的管理行動。" })}
        ${insightActs.length ? `<ul class="acts" style="margin-top:10px">${insightActs.map(insightRow).join("")}</ul>` : ""}
      </div>
      <div class="panel"><h3>建議建立的行動 <span class="faint" style="font-weight:400;letter-spacing:0">規則產生，還沒建立的</span></h3>
        ${cards.length ? `<ul class="acts">${cards.map(cardRow).join("")}</ul>` : '<div class="empty">沒有新的建議。</div>'}
      </div>
    </section>
  </div>`;
  bindRows(el);
  el.querySelectorAll("[data-coach]").forEach((b) => b.onclick = async () => {
    const w = watch.find((x) => x.staff_id === Number(b.dataset.coach)); if (!w) return; b.disabled = true;
    const r = await createAction({ kind: "coach", title: `${w.name}：${w.issue.text.split("（")[0]}`, staff_id: w.staff_id, priority: "medium", metric_key: metricKeyFor(w.issue.key), why: w.pattern, measure: `接下來 30 天的${w.issue.text.split(" ")[0]}`, action: w.coaching, owner_role: "manager" });
    if (r.ok) render(el, ctx); else b.disabled = false;
  });
  el.querySelectorAll("[data-mk]").forEach((b) => b.onclick = async () => {
    const c = d.cards[Number(b.dataset.mk)]; if (!c) return; b.disabled = true;
    const r = await createAction({ kind: c.kind, title: c.title, staff_id: c.staff_ids[0] ?? null, priority: c.priority, metric_key: c.metric_key, why: c.why, measure: c.measure, action: c.action, owner_role: "manager" });
    if (r.ok) render(el, ctx); else b.disabled = false;
  });
  el.querySelectorAll("[data-mst]").forEach((b) => b.onclick = async () => {
    b.disabled = true; const note = b.dataset.mst === "done" ? (prompt("結果備註（可留空）") || "") : "";
    await updateAction(b.dataset.mid, { status: b.dataset.mst, result_note: note }); render(el, ctx);
  });
  el.querySelectorAll("[data-act]").forEach((b) => b.onclick = async () => {
    const r = await api(`/api/actions/${b.dataset.act}`, { status: b.dataset.st }, "PATCH");
    toast(r.ok ? ({ approved: "已核准", dismissed: "已駁回", done: "已完成" }[b.dataset.st] || "已更新") : (r.message || "失敗"));
    render(el, ctx);
  });
}
