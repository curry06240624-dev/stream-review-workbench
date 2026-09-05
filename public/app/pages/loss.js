/* 流失原因：哪裡掉＋為什麼掉。本期 vs 前期、分項（業務／車款／車型／階段／價格帶／組別）、每位客戶的主因／副因／替代可能／信心／證據。
   規則判定；客戶自己講的才是「確定」；沉默只能「可能」；推定流失另列不計入總數。 */
import { api } from "../api.js";
import { esc, pct, num, chip, table, bindRows, pageHead, periodSeg, fmtD, fmtDT, chipConf, wan, drawChart, DRIVER } from "../ui.js";

const DIMS = [["staff", "業務"], ["vehicle", "車款"], ["body", "車型"], ["stage", "階段"], ["band", "價格帶"], ["team", "組別"]];

export async function render(el, ctx) {
  const days = Number(ctx.query.days || 30), by = DIMS.some(([k]) => k === ctx.query.by) ? ctx.query.by : "staff", reason = ctx.query.reason || "";
  const r = await api(`/api/loss?days=${days}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`);
  if (!r.ok) { el.innerHTML = `<div class="empty">${esc(r.message || "流失原因只開放給老闆與主管。")}</div>`; return; }
  const top = r.reasons[0], rising = [...r.reasons].filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta)[0];
  const aiLine = r.totals.lost ? `${r.totals.lost} 位未成交（前期 ${r.totals.prev}）${top ? `，最大原因「${top.label}」${top.k} 位` : ""}${rising && rising.key !== top?.key ? `；增加最多「${rising.label}」（${rising.prev_k} → ${rising.k}）` : ""}${r.driver.process ? `；${r.driver.process} 位是流程面，公司可以直接改` : ""}。` : "本期沒有未成交結案的客戶。";

  const reasonRows = r.reasons.filter((x) => x.k || x.prev_k).map((x) => `<a class="lossrow" href="/loss?days=${days}&by=${by}&reason=${x.key}" data-link style="color:var(--text)"><div><b>${esc(x.label)}</b> ${x.process ? chip("流程面", "amber") : ""} <span class="ins">${x.k}/${r.totals.lost}</span><div class="bar" style="margin-top:4px"><i class="${x.process ? "warn" : ""}" style="width:${Math.round((x.rate ?? 0) * 100)}%"></i></div></div><div class="num">${x.k} 位 <span class="faint">前期 ${x.prev_k}${x.delta ? ` ${x.delta > 0 ? "↑" : "↓"}${Math.abs(x.delta)}` : ""}</span></div></a>`).join("");
  const groups = r.by[by] || [];
  const groupCols = [
    { key: "label", label: DIMS.find(([k]) => k === by)?.[1] || by }, { key: "n", label: "流失", num: true },
    { key: "top", label: "最常見原因", render: (g) => g.top.map((t) => `${esc(t.label)} <span class="ins">${t.k}</span>`).join(" · ") },
    { key: "process", label: "流程面", num: true, render: (g) => (g.process ? `<span class="warn">${g.process}</span>` : "0") },
  ];
  const listCols = [
    { key: "closed_at", label: "結案", render: (x) => fmtD(x.closed_at || x.last_customer_at) }, { key: "contact", label: "客戶" }, { key: "staff", label: "業務" }, { key: "vehicle", label: "車款", render: (x) => `${esc(x.vehicle)}${x.list_price ? ` <span class="faint">${wan(x.list_price)}</span>` : ""}` },
    { key: "stage_label", label: "掉在", render: (x) => `${esc(x.stage_label)}後` },
    { key: "reason_label", label: "主因", render: (x) => `<b>${esc(x.reason_label)}</b>${x.secondary_label ? `<div class="faint" style="font-size:12px">副因 ${esc(x.secondary_label)}</div>` : ""}${x.alt_label ? `<div class="faint" style="font-size:12px">替代可能 ${esc(x.alt_label)}</div>` : ""}` },
    { key: "driver", label: "面向", render: (x) => chip(DRIVER[x.driver] || x.driver, x.driver === "process" ? "amber" : "") },
    { key: "confidence", label: "信心", render: (x) => chipConf(x.confidence) },
    { key: "summary", label: "證據摘要", render: (x) => `<span class="faint" style="font-size:12px">${esc(x.summary)}</span>` },
  ];
  const suspCols = [{ key: "contact", label: "客戶" }, { key: "staff", label: "業務" }, { key: "vehicle", label: "車款" }, { key: "stage_label", label: "掉在" }, { key: "reason_label", label: "推定原因", render: (x) => `${esc(x.reason_label)} ${chipConf(x.confidence)}` }, { key: "last_customer_at", label: "最後客戶訊息", render: (x) => fmtDT(x.last_customer_at) }];

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("流失原因", aiLine, `<span class="faint" style="margin-right:10px">最近 ${days} 天（以結案日計）· 對照前 ${days} 天</span>${periodSeg(days, (dd) => ctx.nav(`/loss?days=${dd}&by=${by}`))}`)}
    <section class="stats">
      <div class="stat"><div class="l">未成交</div><b>${num(r.totals.lost)}</b><div class="d faint">前期 ${num(r.totals.prev)}</div></div>
      <div class="stat ${r.driver.process ? "warn" : ""}"><div class="l">流程面（回覆太慢／跟進不足）</div><b>${num(r.driver.process)}</b><div class="d faint">${pct(r.totals.lost ? r.driver.process / r.totals.lost : null)}</div></div>
      <div class="stat"><div class="l">客戶面</div><b>${num(r.driver.customer)}</b><div class="d faint">價格、貸款、車況、家人、時機…</div></div>
      <div class="stat"><div class="l">不明</div><b>${num(r.driver.unclear)}</b></div>
      <div class="stat"><div class="l">推定流失（沉默 ≥21 天）</div><b>${num(r.totals.suspected)}</b><div class="d faint">不計入總數</div></div>
    </section>
    <section class="grid g2">
      <div class="panel"><h3>為什麼沒買 <span class="faint" style="letter-spacing:0;font-weight:400">點原因篩選下面的清單</span></h3>${reasonRows || '<div class="empty">沒有資料</div>'}</div>
      <div class="panel"><h3>本期 vs 前期</h3><div style="height:230px"><canvas id="lossChart"></canvas></div></div>
    </section>
    <section class="panel"><h3>分項 <span class="seg" id="bySeg" style="margin-left:10px">${DIMS.map(([k, l]) => `<button class="${k === by ? "on" : ""}" data-by="${k}">${l}</button>`).join("")}</span></h3>
      ${table(groupCols, groups, { rowHref: by === "staff" ? (g) => `/conversations?staff=${encodeURIComponent(g.label)}&outcome=lost` : by === "vehicle" ? (g) => `/conversations?vehicle=${encodeURIComponent(g.label)}&outcome=lost` : undefined, dense: true, empty: "本期沒有流失" })}</section>
    <section class="panel"><h3>未成交客戶 ${reason ? `<span class="faint" style="letter-spacing:0;font-weight:400">· 只看「${esc(r.reasons.find((x) => x.key === reason)?.label || reason)}」</span> <a href="/loss?days=${days}&by=${by}" data-link style="font-weight:400;letter-spacing:0">清除</a>` : ""} <span class="faint" style="letter-spacing:0;font-weight:400">${r.list.length} 位 · 點一列開對話看證據</span></h3>
      ${table(listCols, r.list, { rowHref: (x) => `/conversations/${x.lead_id}`, dense: true, empty: "沒有符合的客戶" })}</section>
    ${r.suspected.length ? `<section class="panel"><details><summary style="cursor:pointer;color:var(--muted)">推定流失 ${r.suspected.length} 位（沉默 21 天以上、未結案；原因最多只到「可能」）</summary><div style="margin-top:10px">${table(suspCols, r.suspected, { rowHref: (x) => `/conversations/${x.lead_id}`, dense: true })}</div></details></section>` : ""}
  </div>`;
  bindRows(el);
  el.querySelectorAll("#bySeg button").forEach((b) => b.onclick = () => ctx.nav(`/loss?days=${days}&by=${b.dataset.by}${reason ? `&reason=${reason}` : ""}`));
  const shown = r.reasons.filter((x) => x.k || x.prev_k).slice(0, 9);
  drawChart(el.querySelector("#lossChart"), shown.length ? { type: "bar", labels: shown.map((x) => x.label), series: [{ label: "本期", data: shown.map((x) => x.k) }, { label: "前期", data: shown.map((x) => x.prev_k), tone: "accent" }] } : null);
}
