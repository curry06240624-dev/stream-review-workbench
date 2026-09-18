/* 漏斗與價格流失：每一階段都能點進去看是哪些客戶；價格後流失拆到業務、車型、車款；最後是業務與車款總表。 */
import { api } from "../api.js";
import { esc, pct, nt, num, delta, funnelStrip, periodSeg, table, bindRows, pageHead, CONF, drawChart, lostReason, bodyType, periodLabel } from "../ui.js";

const stat = (label, value, extra = "", cls = "") => `<div class="stat ${cls}"><div class="l">${esc(label)}</div><b>${value}</b>${extra ? `<div class="d">${extra}</div>` : ""}</div>`;
const sub = (t) => `<h4 class="sub">${esc(t)}</h4>`;
/* 樣本 ≥3 且流失率比全公司高 10 點以上才標琥珀；小樣本的 100% 不是洞察 */
const warnRate = (base) => (r) => (r.rate != null && base != null && r.priced >= 3 && r.rate >= base + 0.1 ? "warn" : "");
const bdCols = (key, label, base) => [
  { key, label }, { key: "priced", label: "報價", num: true }, { key: "dropped", label: "流失", num: true },
  { key: "rate", label: "流失率", num: true, render: (r) => pct(r.rate), cls: warnRate(base) },
];
const bd = (rows) => (rows || []).filter((r) => r.priced > 0).sort((x, y) => (y.rate ?? -1) - (x.rate ?? -1) || y.priced - x.priced);
const pdq = (k, v) => `/conversations?flag=price_dropoff&${k}=${encodeURIComponent(v)}`;

export async function render(el, ctx) {
  const days = Number(ctx.query.days || 7);
  const [a, ins, se] = await Promise.all([api(`/api/analytics?days=${days}`), api("/api/insights"), api("/api/series?weeks=10")]);
  if (!a.ok) { el.innerHTML = `<div class="empty">${esc(a.message || "沒有權限看全公司數字。")}</div>`; return; }
  const f = a.funnel, c = a.conversion, pd = a.price_dropoff, d = a.deals;
  const ev = (k) => f.events[k] || 0, pev = (k) => f.prev_events[k] || 0;
  const st = (key, label, type, href, conv) => ({ key, label, n: ev(type), conv, delta: delta(ev(type), pev(type), { fmt: num }), href });
  const stages = [
    { key: "leads", label: "新進線", n: f.leads, conv: null, delta: delta(f.leads, f.prev_leads, { fmt: num }), href: "/conversations" },
    st("interest", "車款興趣", "VEHICLE_INTEREST", "/conversations?event=VEHICLE_INTEREST", null),
    st("discussion", "有來有往", "ACTIVE_DISCUSSION", "/conversations?event=ACTIVE_DISCUSSION", null),
    st("priced", "報價", "PRICE_MENTIONED", "/conversations?event=PRICE_MENTIONED", c.price_to_booking?.rate),
    st("booked", "預約", "APPOINTMENT_BOOKED", "/conversations?event=APPOINTMENT_BOOKED", c.booking_to_visit?.rate),
    st("visit", "到店", "STORE_VISIT", "/conversations?event=STORE_VISIT", c.visit_to_sold?.rate),
    { key: "sold", label: "成交", n: d.sold, conv: null, delta: delta(d.sold, d.prev_sold, { fmt: num }), href: "/conversations?outcome=sold" },
  ];
  const pairs = [["price_to_booking", "priced", "報價→預約"], ["booking_to_visit", "booked", "預約→到店"], ["visit_to_sold", "visit", "到店→成交"]];
  const weakest = pairs.map(([k, key, label]) => ({ key, label, ...(c[k] || {}) })).filter((x) => x.n >= 8 && x.rate != null).sort((x, y) => x.rate - y.rate)[0];
  const priceInsight = (ins.insights || []).find((i) => i.kind === "price_dropoff" || /報價|價格/.test(i.title));
  const aiLine = priceInsight ? `#${priceInsight.id} ${priceInsight.title}` : weakest ? `最弱的一段是 ${weakest.label}：${pct(weakest.rate)}（n=${weakest.n}）` : "樣本還不足以指出最弱的一段。";
  const weeks = se.weeks || [];
  const order = ["CONFIRMED", "STRONGLY_SUGGESTED", "POSSIBLE", "UNCLEAR"];
  const byConf = Object.entries(pd.by_confidence || {}).sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0]));

  const staffCols = [
    { key: "name", label: "業務" }, { key: "team", label: "組別" }, { key: "leads", label: "進線", num: true }, { key: "priced", label: "報價", num: true },
    { key: "dropped", label: "價格後流失", num: true, render: (r) => `${num(r.dropped)} <span class="faint">${r.priced ? pct(r.dropped / r.priced) : "—"}</span>`, cls: (r) => (r.priced >= 3 && pd.rate != null && r.dropped / r.priced >= pd.rate + 0.1 ? "warn" : "") },
    { key: "booked", label: "預約", num: true }, { key: "sold", label: "成交", num: true }, { key: "gross_profit", label: "毛利", num: true, render: (r) => nt(r.gross_profit) },
    { key: "median_first_response_min", label: "首次回覆中位數", num: true, render: (r) => (r.median_first_response_min == null ? "—" : `${r.median_first_response_min} 分`) },
    { key: "followups", label: "跟進", num: true },
  ];
  const staffRows = (a.staff || []).slice().sort((x, y) => y.gross_profit - x.gross_profit);
  const vehCols = [
    { key: "name", label: "車款" }, { key: "body_type", label: "車型", render: (r) => esc(bodyType(r.body_type)) }, { key: "inquiries", label: "詢問", num: true }, { key: "priced", label: "報價", num: true },
    { key: "dropped", label: "流失", num: true }, { key: "booked", label: "預約", num: true }, { key: "sold", label: "成交", num: true },
    { key: "inquiry_to_sold", label: "詢問→成交", num: true, render: (r) => pct(r.inquiry_to_sold) }, { key: "gross_profit", label: "成交毛利", num: true, render: (r) => nt(r.gross_profit) },
    { key: "sell_price", label: "調作價", num: true, render: (r) => (r.sell_price ? nt(r.sell_price) : '<span class="faint">—</span>') },
    { key: "est_gp", label: "在庫估算毛利", num: true, render: (r) => (r.est_gp == null ? '<span class="faint">—</span>' : nt(r.est_gp)), cls: (r) => (r.est_gp != null && r.est_gp < 0 ? "warn" : "") },
  ];
  const vehRows = (a.vehicles || []).slice(0, 10);

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("漏斗與價格流失", aiLine, `<span class="faint" style="margin-right:10px">${periodLabel(days)}</span>${periodSeg(days, (dd) => ctx.nav(`/funnel?days=${dd}`))}`)}
    <section class="panel"><h3>漏斗 <span class="faint" style="font-weight:400;letter-spacing:0">點任何一階看是哪些客戶 · 階段旁的百分比＝之後走到下一階的比例（以客戶計）</span></h3>
      ${funnelStrip(stages, { bottleneck: weakest ? weakest.key : null })}
    </section>
    <section class="panel"><h3>價格後流失 <span class="sp"></span><a href="/conversations?flag=price_dropoff" data-link style="font-weight:400;letter-spacing:0">全部流失客戶 ›</a></h3>
      <div class="stats">
        ${stat("報價次數", num(pd.base), delta(pd.base, pd.prev_base, { fmt: num }))}
        ${stat("報價後未再回覆", num(pd.count), delta(pd.count, pd.prev_count, { goodIsUp: false, fmt: num }), pd.count ? "warn" : "")}
        ${stat("流失率", pct(pd.rate), `${delta(pd.rate, pd.prev_rate, { goodIsUp: false })} <span class="faint">前期 ${pct(pd.prev_rate)}</span>`)}
        ${stat("報價→預約", pct(c.price_to_booking?.rate), `<span class="faint">n=${c.price_to_booking?.n ?? 0} · 前期 ${pct(c.price_to_booking?.prev_rate)}</span>`)}
        ${stat("判定信心", byConf.length ? byConf.map(([k, v]) => `<span class="chip conf-${k}" style="font-size:11px">${CONF[k] || k} ${v}</span>`).join(" ") : "—")}
      </div>
      <div class="grid g3" style="margin-top:14px">
        <div>${sub("依業務")}${table(bdCols("staff", "業務", pd.rate), bd(pd.by_staff), { rowHref: (r) => pdq("staff", r.staff), dense: true, empty: "本期沒有報價" })}</div>
        <div>${sub("依車型")}${table(bdCols("body_type", "車型", pd.rate), bd(pd.by_body_type).map((r) => ({ ...r, body_type: bodyType(r.body_type) })), { dense: true, empty: "本期沒有報價" })}</div>
        <div>${sub("依車款")}${table(bdCols("vehicle", "車款", pd.rate), bd(pd.by_vehicle).slice(0, 8), { rowHref: (r) => pdq("vehicle", r.vehicle), dense: true, empty: "本期沒有報價" })}</div>
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div>${sub("每週趨勢：報價 vs 價格後流失")}<div style="height:190px"><canvas id="pdTrend"></canvas></div></div>
        <div>${sub("流失原因（成交帳本）")}${table([{ key: "reason", label: "原因", render: (r) => esc(lostReason(r.reason)) }, { key: "n", label: "筆數", num: true }], d.lost_reasons || [], { dense: true, empty: "本期沒有標記流失原因" })}
          <div class="faint" style="margin-top:8px">本期流失 ${num(d.lost)} 台 · <a href="/conversations?outcome=lost" data-link>看流失客戶 ›</a></div></div>
      </div>
    </section>
    <section class="panel"><h3>業務 <span class="faint" style="font-weight:400;letter-spacing:0">累計 · 點名字看他的客戶</span></h3>
      ${table(staffCols, staffRows, { rowHref: (r) => `/conversations?staff=${encodeURIComponent(r.name)}`, dense: true, empty: "沒有業務資料" })}
    </section>
    <section class="panel"><h3>車款 <span class="faint" style="font-weight:400;letter-spacing:0">累計 · 依詢問數前 10</span></h3>
      ${table(vehCols, vehRows, { rowHref: (r) => `/conversations?vehicle=${encodeURIComponent(r.name)}`, dense: true, empty: "沒有車款資料" })}
    </section>
  </div>`;
  bindRows(el);
  drawChart(el.querySelector("#pdTrend"), weeks.length ? { type: "bar", labels: weeks.map((w) => w.week_end.slice(5)), series: [{ label: "報價", data: weeks.map((w) => w.priced) }, { label: "價格後流失", data: weeks.map((w) => w.dropoff), style: "line", tone: "warn" }] } : null);
}
