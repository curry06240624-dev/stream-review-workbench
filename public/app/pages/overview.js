/* CEO 總覽：30 秒內回答「現在最需要我處理什麼」。極簡：簡報 → 洞察卡 → 漏斗快照 → 四格 → 需要注意前 5。 */
import { api } from "../api.js";
import { h, raw, esc, pct, nt, num, delta, insightCard, kpi, funnelStrip, periodSeg, ago, chip, toast } from "../ui.js";

const KIND = { high_intent_no_followup: "急迫未跟進", price_dropoff_no_followup: "報價後未跟進", booked_but_no_visit: "預約已過未到店", financing_unresolved: "貸款未回覆" };
const linkify = (s) => esc(s).replace(/#(\d+)/g, (_, id) => `<a href="/insights/${id}" data-link>#${id}</a>`);

export async function render(el, ctx) {
  const days = Number(ctx.query.days || 7);
  const [a, ins, br, se] = await Promise.all([
    api(`/api/analytics?days=${days}`), api("/api/insights"), api("/api/brief"), api("/api/series?weeks=8"),
  ]);
  if (!a.ok) { el.innerHTML = `<div class="empty">${esc(a.message || "沒有權限看全公司數字。")}</div>`; return; }
  const weeks = se.weeks || [];
  const series = (k) => weeks.map((w) => w[k]);
  const c = a.conversion, d = a.deals, ap = a.appointments, f = a.funnel;
  const insights = (ins.insights || []).slice(0, 4);

  const brief = br.brief?.content;
  const briefLines = brief
    ? [["發生了什麼", brief.happened], ["變了什麼", brief.changed], ["最該注意", brief.attention], ["今天做什麼", brief.do_today]]
    : [["發生了什麼", `最近 ${days} 天新進線 ${f.leads} 位、報價 ${a.price_dropoff.base} 次、成交 ${d.sold} 台。`],
       ["變了什麼", `成交 ${d.sold} 台（前期 ${d.prev_sold}），價格後流失率 ${pct(a.price_dropoff.rate)}（前期 ${pct(a.price_dropoff.prev_rate)}）。`],
       ["最該注意", insights[0] ? `#${insights[0].id} ${insights[0].title}` : "目前沒有成立的洞察。"],
       ["今天做什麼", a.attention.length ? `先處理需要注意清單的 ${a.attention.length} 位客戶。` : "看一遍需要注意清單。"]];

  const stages = [
    { key: "leads", label: "新進線", n: f.leads, conv: null, delta: delta(f.leads, f.prev_leads, { fmt: num }), href: "/conversations" },
    { key: "priced", label: "報價", n: f.events.PRICE_MENTIONED || 0, conv: c.price_to_booking?.rate, delta: delta(f.events.PRICE_MENTIONED || 0, f.prev_events.PRICE_MENTIONED || 0, { fmt: num }), href: "/conversations?event=PRICE_MENTIONED" },
    { key: "booked", label: "預約", n: f.events.APPOINTMENT_BOOKED || 0, conv: c.booking_to_visit?.rate, delta: delta(f.events.APPOINTMENT_BOOKED || 0, f.prev_events.APPOINTMENT_BOOKED || 0, { fmt: num }), href: "/appointments" },
    { key: "visit", label: "到店", n: f.events.STORE_VISIT || 0, conv: c.visit_to_sold?.rate, delta: delta(f.events.STORE_VISIT || 0, f.prev_events.STORE_VISIT || 0, { fmt: num }), href: "/appointments" },
    { key: "sold", label: "成交", n: d.sold, conv: null, delta: delta(d.sold, d.prev_sold, { fmt: num }), href: "/deals" },
  ];
  const weakest = ["price_to_booking", "booking_to_visit", "visit_to_sold"].map((k) => [k, c[k]]).filter(([, v]) => v && v.n >= 8 && v.rate != null).sort((x, y) => x[1].rate - y[1].rate)[0];
  const bottleneck = weakest ? { price_to_booking: "priced", booking_to_visit: "booked", visit_to_sold: "visit" }[weakest[0]] : null;

  const attention = a.attention.slice(0, 5);
  const isAdmin = ctx.me?.role === "admin";

  el.innerHTML = h`<div class="wrap stack">
    <div class="ph"><h1>CEO 總覽</h1><span class="faint">最近 ${days} 天 · 對照前 ${days} 天</span><span class="sp"></span>${raw(periodSeg(days, (dd) => ctx.nav(`/overview?days=${dd}`)))}
      ${isAdmin ? raw('<button class="btn sm" id="rerun" style="margin-left:10px">重新分析</button>') : ""}</div>

    <section class="panel brief"><h3>AI 指揮簡報 ${brief ? raw(h`<span class="faint" style="letter-spacing:0;font-weight:400">${br.brief.brief_date} · ${br.brief.model === "template" ? "規則版" : br.brief.model}</span>`) : ""}</h3>
      ${raw(briefLines.map(([k, v]) => `<p><b>${esc(k)}</b>${linkify(v)}</p>`).join(""))}
    </section>

    <section>${insights.length ? raw(`<div class="cards">${insights.map((i) => insightCard(i)).join("")}</div>`) : raw('<div class="panel empty">目前沒有成立的洞察。按「重新分析」或匯入資料。</div>')}</section>

    <section class="panel"><h3>漏斗快照 <span class="sp"></span><a href="/funnel" data-link style="font-weight:400;letter-spacing:0">完整漏斗 ›</a></h3>${raw(funnelStrip(stages, { slim: true, bottleneck }))}</section>

    <section class="grid g4">
      ${raw(kpi("營收", nt(d.revenue), delta(d.revenue, d.prev_revenue, { fmt: nt }), series("revenue")))}
      ${raw(kpi("毛利", nt(d.gross_profit), delta(d.gross_profit, d.prev_gross_profit, { fmt: nt }), series("gp")))}
      ${raw(kpi("預約成立", num(ap.booked), delta(ap.booked, ap.prev_booked, { fmt: num }), series("booked")))}
      ${raw(kpi("到店", num(a.visits.count), delta(a.visits.count, a.visits.prev_count, { fmt: num }), series("visits")))}
    </section>

    <section class="panel"><h3>需要注意 <span class="faint" style="letter-spacing:0;font-weight:400">${a.attention.length} 位</span><span class="sp"></span><a href="/attention" data-link style="font-weight:400;letter-spacing:0">查看全部 ›</a></h3>
      ${attention.length ? raw(`<table class="tbl dense"><tbody>${attention.map((x) => `<tr class="row" data-href="/conversations/${x.lead_id}">
          <td>${esc(x.contact)}</td><td class="muted">${esc(x.staff)}</td><td class="muted">${esc(x.vehicle)}</td>
          <td>${chip(KIND[x.kind] || x.kind, x.kind === "high_intent_no_followup" ? "amber" : "")}</td><td class="muted">${esc(x.reason)}</td></tr>`).join("")}</tbody></table>`)
        : raw('<div class="empty">沒有需要注意的客戶。</div>')}
    </section>
  </div>`;

  el.querySelectorAll("tr[data-href]").forEach((tr) => tr.addEventListener("click", () => ctx.nav(tr.dataset.href)));
  const rr = document.getElementById("rerun");
  if (rr) rr.onclick = async () => { rr.disabled = true; rr.textContent = "分析中…（約 20 秒）"; const r = await api("/api/insights/run", { days }); toast(r.ok ? `完成：${r.persisted} 條洞察、簡報 ${r.brief?.mode === "ai" ? "AI" : "規則版"}` : (r.message || "失敗")); render(el, ctx); };
}
