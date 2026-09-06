/* 成交與毛利：財務語氣、中性配色。成交表看每一台的售價／成本／毛利，只有低於成本標琥珀。
   毛利＝售價－車源表成本（估算，標「估算」）；同行車或車號空白沒有成本 → 「無成本」，不算進毛利。正式毛利以會計為準。 */
import { api } from "../api.js";
import { esc, pct, nt, num, delta, fmtD, chip, table, bindRows, pageHead, periodSeg, drawChart, lostReason, gpCell, LOAN } from "../ui.js";

const stat = (label, value, extra = "", cls = "") => `<div class="stat ${cls}"><div class="l">${esc(label)}</div><b>${value}</b>${extra ? `<div class="d">${extra}</div>` : ""}</div>`;

export async function render(el, ctx) {
  const days = Number(ctx.query.days || 30);
  const tab = ctx.query.tab === "lost" ? "lost" : "sold";
  const [a, li, se] = await Promise.all([api(`/api/analytics?days=${days}`), api(`/api/deals/list?days=${days}`), api("/api/series?weeks=10")]);
  if (!a.ok) { el.innerHTML = `<div class="empty">${esc(a.message || "沒有權限看全公司數字。")}</div>`; return; }
  const d = a.deals, rows = li.rows || [], weeks = se.weeks || [];
  const sold = rows.filter((x) => x.status === "sold"), lost = rows.filter((x) => x.status === "lost");
  const reserved = sold.filter((x) => x.delivered === 0), reservedAmt = reserved.reduce((s, x) => s + (x.sale_price || 0), 0);   // 成交但還沒交車（收訂／送貸／過件）
  const below = sold.filter((x) => x.gp_known && x.gross_profit < 0);
  const unknownNote = d.gp_unknown ? `另有 ${d.gp_unknown} 筆成交沒有成本（同行車或車號空白），毛利未計入。` : "";
  const reservedNote = reserved.length ? `成交裡有 ${reserved.length} 台還沒交車（車源表 收訂／送貸／過件，${nt(reservedAmt)}），收訂就算成交。` : "";
  const aiLine = (below.length ? `${below.length} 筆成交低於成本，先看這幾筆是讓價換成交還是車況問題。${unknownNote}`
    : d.sold ? `毛利率 ${pct(d.gp_margin)}，平均每台毛利 ${nt(d.avg_gp)}（車源表成本估算，正式以會計為準）。${unknownNote}` : "本期沒有成交。") + reservedNote;

  const soldCols = [
    { key: "closed_at", label: "成交日", render: (x) => (x.source_system === "sheet" ? `${fmtD(x.closed_at)} <span class="faint" title="車源表沒有成交日，以匯入日計">匯入日</span>` : fmtD(x.closed_at)) },
    { key: "contact", label: "客戶", render: (x) => (x.lead_id ? esc(x.contact) : `<span class="faint">${esc(x.contact)}</span>`) }, { key: "vehicle", label: "車款" },
    { key: "plate", label: "車號", render: (x) => (x.plate || x.vehicle_plate ? `<span class="mono" style="font-size:12px">${esc(x.plate || x.vehicle_plate)}</span>` : '<span class="faint">空白</span>') },
    { key: "source_kind", label: "來源", render: (x) => `${x.source_system === "sheet" ? (String(x.sheet_status || "").startsWith("車源表已移除") ? chip("車源表已移除 · 推定已交車", "amber") : chip(`車源表${x.sheet_status ? " · " + esc(x.sheet_status) : ""}`)) : x.source_kind === "peer" ? chip(`同行${x.peer_dealer ? " · " + esc(x.peer_dealer) : ""}`, "amber") : chip("庫存")}${x.delivered === 0 ? " " + chip("未交車", "amber") : ""}` },
    { key: "staff", label: "業務", render: (x) => esc(x.staff || "未指派") },
    { key: "sale_price", label: "售價", num: true, render: (x) => `${nt(x.sale_price)}${x.vehicle_sell_price && x.sale_price && x.sale_price < x.vehicle_sell_price ? ` ${chip("低於調作價 " + nt(x.vehicle_sell_price), "amber")}` : ""}` }, { key: "cost", label: "成本", num: true, render: (x) => (x.gp_known ? nt(x.cost) : '<span class="faint">—</span>') },
    { key: "gross_profit", label: "毛利", num: true, render: (x) => gpCell(x), cls: (x) => (x.gp_known && x.gross_profit < 0 ? "warn" : "") },
    { key: "margin", label: "毛利率", num: true, render: (x) => (x.gp_known && x.sale_price ? pct(x.gross_profit / x.sale_price, 1) : "—") },
    { key: "loan_status", label: "貸款", render: (x) => LOAN[x.loan_status] || "—" },
    { key: "days", label: "進線到成交", num: true, render: (x) => (x.days == null ? "—" : `${x.days} 天`) },
  ];
  const lostCols = [
    { key: "closed_at", label: "結案日", render: (x) => fmtD(x.closed_at) }, { key: "contact", label: "客戶" }, { key: "vehicle", label: "車款" }, { key: "staff", label: "業務", render: (x) => esc(x.staff || "未指派") },
    { key: "lost_reason", label: "原因", render: (x) => chip(lostReason(x.lost_reason)) },
    { key: "days", label: "進線到流失", num: true, render: (x) => (x.days == null ? "—" : `${x.days} 天`) },
  ];
  const reservedCols = [
    { key: "vehicle", label: "車款" }, { key: "plate", label: "車號", render: (x) => (x.plate || x.vehicle_plate ? `<span class="mono" style="font-size:12px">${esc(x.plate || x.vehicle_plate)}</span>` : '<span class="faint">空白</span>') },
    { key: "sheet_status", label: "車源表狀態", render: (x) => chip(esc(x.sheet_status || "收訂"), "amber") },
    { key: "staff", label: "業務", render: (x) => esc(x.staff || "未指派") },
    { key: "sale_price", label: "售價", num: true, render: (x) => `${nt(x.sale_price)}${x.price_source === "sheet_list" ? ' <span class="faint" title="車源表沒填調作價，先用開價">開價</span>' : ""}` },
    { key: "cost", label: "成本", num: true, render: (x) => (x.gp_known ? nt(x.cost) : '<span class="faint">—</span>') },
    { key: "gross_profit", label: "估算毛利", num: true, render: (x) => gpCell(x) },
    { key: "loan_status", label: "貸款", render: (x) => LOAN[x.loan_status] || "—" },
    { key: "closed_at", label: "收訂（匯入日）", render: (x) => fmtD(x.closed_at) },
  ];
  const staffCols = [
    { key: "staff", label: "業務" }, { key: "sold", label: "成交", num: true },
    { key: "revenue", label: "營收", num: true, render: (x) => nt(x.revenue) },
    { key: "gross_profit", label: "毛利（估算）", num: true, render: (x) => `${nt(x.gross_profit)}${x.gp_unknown ? ` <span class="ins">${x.gp_unknown} 筆無成本</span>` : ""}` },
    { key: "avg", label: "平均毛利", num: true, render: (x) => nt(x.sold - (x.gp_unknown || 0) ? x.gross_profit / (x.sold - (x.gp_unknown || 0)) : null) },
  ];
  const topReasons = (d.lost_reasons || []).slice(0, 2).map((x) => `${lostReason(x.reason)} ${x.n}`).join(" · ");

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("成交與毛利", aiLine, `<span class="faint" style="margin-right:10px">最近 ${days} 天 · 對照前 ${days} 天</span>${periodSeg(days, (dd) => ctx.nav(`/deals?days=${dd}&tab=${tab}`))}`)}
    <section class="stats">
      ${stat("成交", `${num(d.sold)} 台`, `${delta(d.sold, d.prev_sold, { fmt: num })}${d.peer_sold ? ` <span class="faint">同行 ${d.peer_sold}</span>` : ""}${d.sheet_sold ? ` <span class="faint">車源表 ${d.sheet_sold}</span>` : ""}${d.undelivered ? ` <span class="faint">未交車 ${d.undelivered}</span>` : ""}`)}
      ${stat("營收", nt(d.revenue), delta(d.revenue, d.prev_revenue, { fmt: nt }))}
      ${stat("未交車", `${reserved.length} 台`, `<span class="faint">${nt(reservedAmt)} · 收訂／送貸／過件，已算在成交裡</span>`)}
      ${stat(d.gp_estimate ? "毛利（估算）" : "毛利", nt(d.gross_profit), `${delta(d.gross_profit, d.prev_gross_profit, { fmt: nt })} <span class="faint">毛利率 ${pct(d.gp_margin)} · 成本知道的 ${num(d.gp_known)} 台</span>`)}
      ${stat("平均毛利", nt(d.avg_gp))}
      ${stat("低於成本", `${num(d.below_cost)} 筆`, "", d.below_cost ? "warn" : "")}
      ${stat("無成本", `${num(d.gp_unknown)} 筆`, '<a href="/reconcile" data-link>待確認配對 ›</a>', d.gp_unknown ? "warn" : "")}
      ${stat("流失", `${num(d.lost)} 台`, `<span class="faint">${topReasons || "—"}</span>`)}
    </section>
    <section class="grid g2">
      <div class="panel"><h3>每週成交與毛利</h3><div style="height:200px"><canvas id="dealTrend"></canvas></div></div>
      <div class="panel"><h3>依業務 <span class="faint" style="font-weight:400;letter-spacing:0">本期 · 毛利只算成本知道的成交 · 點名字看他成交的客戶</span></h3>
        ${table(staffCols, d.by_staff || [], { rowHref: (x) => `/conversations?staff=${encodeURIComponent(x.staff)}&outcome=sold`, dense: true, empty: "本期沒有成交" })}</div>
    </section>
    <section class="panel"><h3><span class="seg" id="dealTab"><button class="${tab === "sold" ? "on" : ""}" data-t="sold">成交 ${sold.length}</button><button class="${tab === "reserved" ? "on" : ""}" data-t="reserved">未交車 ${reserved.length}</button><button class="${tab === "lost" ? "on" : ""}" data-t="lost">流失 ${lost.length}</button></span><span class="sp"></span><span class="faint" style="font-weight:400;letter-spacing:0">「估算」＝售價－車源表成本；「無成本」＝同行車或車號空白，正式毛利以會計為準 · 點一列開對話</span></h3>
      ${tab === "sold"
        ? table(soldCols, sold, { rowHref: (x) => (x.lead_id ? `/conversations/${x.lead_id}` : null), dense: true, empty: "本期沒有成交" })
        : tab === "reserved" ? table(reservedCols, reserved, { dense: true, empty: "成交的車都交車了" })
        : table(lostCols, lost, { rowHref: (x) => (x.lead_id ? `/conversations/${x.lead_id}` : null), dense: true, empty: "本期沒有流失" })}
    </section>
  </div>`;
  bindRows(el);
  el.querySelectorAll("#dealTab button").forEach((b) => b.onclick = () => ctx.nav(`/deals?days=${days}&tab=${b.dataset.t}`));
  drawChart(el.querySelector("#dealTrend"), weeks.length ? { type: "bar", labels: weeks.map((w) => w.week_end.slice(5)), series: [{ label: "成交台數", data: weeks.map((w) => w.sold) }, { label: "毛利（萬，估算）", data: weeks.map((w) => Math.round(w.gp / 10000)), style: "line", tone: "accent" }] } : null);
}
