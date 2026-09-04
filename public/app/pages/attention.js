/* 需要注意：今天必須處理的客戶＋待辦動作。按急迫排序，每一列點進去就是那位客戶的對話與證據。 */
import { api } from "../api.js";
import { esc, ago, fmtDT, chip, table, bindRows, toast, pageHead } from "../ui.js";

const KIND = { high_intent_no_followup: "急迫未跟進", price_dropoff_no_followup: "報價後未跟進", booked_but_no_visit: "預約已過未到店", financing_unresolved: "貸款未回覆" };
const ORDER = Object.keys(KIND);
const ROLE = { ceo: "老闆", manager: "主管", staff: "業務" };
const ST = { proposed: "待核准", approved: "已核准", done: "已完成", dismissed: "已駁回" };

export async function render(el, ctx) {
  const kind = ctx.query.kind || "";
  const r = await api("/api/attention");
  if (!r.ok) { el.innerHTML = `<div class="empty">${esc(r.message || "讀不到需要注意清單。")}</div>`; return; }
  const items = (r.items || []).slice().sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind) || (Date.parse(x.since) || 0) - (Date.parse(y.since) || 0));
  const shown = kind ? items.filter((x) => x.kind === kind) : items;
  const canAct = ctx.me?.role === "admin" || ctx.me?.role === "operator";
  const urgent = r.counts.high_intent_no_followup || 0;
  const aiLine = items.length ? `${items.length} 位客戶需要處理${urgent ? `，其中 ${urgent} 位急迫、應該今天回` : ""}。` : "目前沒有需要注意的客戶。";
  const actions = r.actions || [], done = r.done || [];

  const cols = [
    { key: "contact", label: "客戶" },
    { key: "kind", label: "狀況", render: (x) => chip(KIND[x.kind] || x.kind, x.kind === "high_intent_no_followup" ? "amber" : "") },
    { key: "staff", label: "業務" }, { key: "vehicle", label: "車款" },
    { key: "since", label: "等了", num: true, render: (x) => (x.since ? ago(x.since) : "—"), cls: (x) => (x.kind === "high_intent_no_followup" ? "warn" : "") },
    { key: "reason", label: "原因" },
    { key: "last_at", label: "最後訊息", num: true, render: (x) => fmtDT(x.last_at) },
  ];
  const actRow = (x) => `<li class="act"><span>${chip(ROLE[x.owner_role] || x.owner_role)}</span><span class="txt">${esc(x.text)}${x.insight_id ? ` <a href="/insights/${x.insight_id}" data-link class="faint">#${x.insight_id} ${esc(x.insight_title || "")}</a>` : ""}</span>
      ${canAct ? (x.status === "proposed"
        ? `<span class="row-actions"><button class="btn sm primary" data-act="${x.id}" data-st="approved">核准</button><button class="btn sm" data-act="${x.id}" data-st="dismissed">駁回</button></span>`
        : `<span class="row-actions">${chip("已核准", "cyan")}<button class="btn sm primary" data-act="${x.id}" data-st="done">完成</button><button class="btn sm" data-act="${x.id}" data-st="dismissed">取消</button></span>`)
      : chip(ST[x.status] || x.status, x.status === "approved" ? "cyan" : "")}</li>`;

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("需要注意", aiLine, `<span class="faint">四條規則現算 · 只看進行中的客戶</span>`)}
    <section class="stats">${ORDER.map((k) => `<a class="stat ${k === kind ? "hot" : ""} ${k === "high_intent_no_followup" && (r.counts[k] || 0) ? "warn" : ""}" href="${k === kind ? "/attention" : `/attention?kind=${k}`}" data-link><div class="l">${KIND[k]}</div><b>${r.counts[k] || 0}</b></a>`).join("")}</section>
    <section class="panel"><h3>客戶清單 <span class="faint" style="font-weight:400;letter-spacing:0">${shown.length} 位${kind ? ` · ${KIND[kind] || kind}` : ""}</span>${kind ? `<span class="sp"></span><a href="/attention" data-link style="font-weight:400;letter-spacing:0">清除篩選</a>` : ""}</h3>
      ${table(cols, shown, { rowHref: (x) => `/conversations/${x.lead_id}`, dense: true, empty: "沒有需要注意的客戶。" })}
    </section>
    <section class="grid g2">
      <div class="panel"><h3>待辦動作 <span class="faint" style="font-weight:400;letter-spacing:0">${actions.length} 條 · 來自洞察</span></h3>
        ${actions.length ? `<ul class="acts">${actions.map(actRow).join("")}</ul>` : `<div class="empty">沒有待辦動作。到 <a href="/overview" data-link>CEO 總覽</a> 的洞察卡核准建議。</div>`}</div>
      <div class="panel"><h3>最近處理</h3>
        ${done.length ? `<ul class="acts">${done.map((x) => `<li class="act"><span>${chip(ST[x.status] || x.status)}</span><span class="txt muted">${esc(x.text)}</span><span class="faint">${fmtDT(x.decided_at)}</span></li>`).join("")}</ul>` : `<div class="empty">還沒有處理紀錄。</div>`}</div>
    </section>
  </div>`;
  bindRows(el);
  el.querySelectorAll("[data-act]").forEach((b) => b.onclick = async () => {
    const res = await api(`/api/actions/${b.dataset.act}`, { status: b.dataset.st }, "PATCH");
    toast(res.ok ? ({ approved: "已核准", dismissed: "已駁回", done: "已完成" }[b.dataset.st] || "已更新") : (res.message || "失敗"));
    render(el, ctx);
  });
}
