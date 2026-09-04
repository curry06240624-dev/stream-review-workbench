/* 預約與到店：戰術頁。時間軸看今天／這週誰要來；右邊盯「逾期未到店」與最近到店的結果。琥珀只給逾期與爽約。 */
import { api } from "../api.js";
import { esc, pct, num, delta, tw, fmtDT, ago, chip, table, bindRows, pageHead, periodSeg } from "../ui.js";

const ST = { booked: "已約", proposed: "提議中", changed: "改期", cancelled: "取消", no_show: "爽約", visited: "已到店", done: "已到店" };
const OUT = { sold: "成交", lost: "流失", pending: "未決" };
const dayKey = (iso) => { const t = tw(iso); return `${t.m}/${String(t.d).padStart(2, "0")}（${t.dow}）`; };
const stat = (label, value, extra = "", cls = "") => `<div class="stat ${cls}"><div class="l">${esc(label)}</div><b>${value}</b>${extra ? `<div class="d">${extra}</div>` : ""}</div>`;

export async function render(el, ctx) {
  const days = Number(ctx.query.days || 7);
  const r = await api(`/api/appointments?days=${days}`);
  if (!r.ok) { el.innerHTML = `<div class="empty">${esc(r.message || "讀不到預約資料。")}</div>`; return; }
  const c = r.counts || {}, tl = r.timeline || [], watch = r.watch || [], recent = r.recent_visits || [];
  const todayKey = dayKey(new Date().toISOString());
  const groups = new Map();
  for (const x of tl) { const k = dayKey(x.scheduled_for); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const overdueN = watch.length;
  const aiLine = overdueN ? `${overdueN} 位預約時間已過但沒有到店紀錄，先確認是爽約還是漏記。` : `預約→到店 ${pct(c.booking_to_visit?.rate)}（n=${c.booking_to_visit?.n ?? 0}），目前沒有逾期未到店。`;

  const row = (x) => {
    const t = tw(x.scheduled_for);
    const cls = x.overdue ? "overdue" : (dayKey(x.scheduled_for) === todayKey && x.status === "booked" && !x.visited ? "now" : "");
    const status = x.visited ? chip("已到店", "cyan") : x.overdue ? chip("逾期未到店", "amber") : chip(ST[x.status] || x.status, x.status === "no_show" ? "amber" : "");
    return `<div class="e"><div class="row ${cls}" data-href="/conversations/${x.lead_id}" style="cursor:pointer"><span class="mono muted">${t.hh}:${t.mm}</span><b>${esc(x.contact)}</b><span class="muted">${esc(x.vehicle)}</span><span class="muted">${esc(x.staff)}</span><span class="sp"></span>${status}</div></div>`;
  };

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("預約與到店", aiLine, `<span class="faint" style="margin-right:10px">最近 ${days} 天 · 對照前 ${days} 天</span>${periodSeg(days, (dd) => ctx.nav(`/appointments?days=${dd}`))}`)}
    <section class="stats">
      ${stat("提議看車", num(c.proposed))}
      ${stat("預約成立", num(c.booked), delta(c.booked, c.prev_booked, { fmt: num }))}
      ${stat("到店", num(c.visits), delta(c.visits, c.prev_visits, { fmt: num }))}
      ${stat("爽約", num(c.no_show), `<span class="faint">爽約率 ${pct(c.no_show_rate)}</span>`, c.no_show ? "warn" : "")}
      ${stat("預約→到店", pct(c.booking_to_visit?.rate), `${delta(c.booking_to_visit?.rate, c.booking_to_visit?.prev_rate)} <span class="faint">n=${c.booking_to_visit?.n ?? 0}</span>`)}
      ${stat("到店→成交", pct(c.visit_to_sold?.rate), `<span class="faint">n=${c.visit_to_sold?.n ?? 0}</span>`)}
      ${stat("逾期未到店", num(overdueN), "", overdueN ? "warn" : "")}
    </section>
    <section class="grid g2">
      <div class="panel"><h3>時間軸 <span class="faint" style="font-weight:400;letter-spacing:0">前 2 天到未來 7 天 · 點一列開對話</span></h3>
        ${groups.size ? `<div class="tl">${[...groups.entries()].map(([k, xs]) => `<div class="t">${esc(k)}${k === todayKey ? "<small>今天</small>" : ""}</div><div>${xs.map(row).join("")}</div>`).join("")}</div>` : `<div class="empty">這段時間沒有預約。</div>`}
      </div>
      <div class="stack">
        <div class="panel"><h3>逾期未到店 <span class="faint" style="font-weight:400;letter-spacing:0">${overdueN} 位 · 先確認是爽約還是漏記</span></h3>
          ${table([
            { key: "contact", label: "客戶" }, { key: "vehicle", label: "車款" }, { key: "staff", label: "業務" },
            { key: "scheduled_for", label: "原定", num: true, render: (x) => fmtDT(x.scheduled_for) },
            { key: "late", label: "已過", num: true, render: (x) => ago(x.scheduled_for), cls: () => "warn" },
          ], watch, { rowHref: (x) => `/conversations/${x.lead_id}`, dense: true, empty: "沒有逾期未到店。" })}</div>
        <div class="panel"><h3>最近到店 <span class="faint" style="font-weight:400;letter-spacing:0">到店後的結果</span></h3>
          ${table([
            { key: "contact", label: "客戶" }, { key: "vehicle", label: "車款" }, { key: "staff", label: "業務" },
            { key: "visited_at", label: "到店", num: true, render: (x) => fmtDT(x.visited_at) },
            { key: "deal_status", label: "結果", render: (x) => { const k = x.deal_status || x.outcome || "pending"; return chip(OUT[k] || k, k === "sold" ? "cyan" : ""); } },
          ], recent, { rowHref: (x) => `/conversations/${x.lead_id}`, dense: true, empty: "還沒有到店紀錄。" })}</div>
      </div>
    </section>
  </div>`;
  bindRows(el);
  el.querySelectorAll(".tl .row[data-href]").forEach((d) => d.addEventListener("click", () => ctx.nav(d.dataset.href)));
}
