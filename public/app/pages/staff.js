/* 員工效能：誰在產生結果、為什麼、強在哪、客戶在哪流失、哪部分真的是他做的、該教什麼。
   全部數字附樣本；沒達門檻顯示「資料不足」；對照只講「觀察到的關聯」。琥珀只給需關注與落後，青只給互動。 */
import { api } from "../api.js";
import { esc, pct, nt, num, chip, table, bindRows, pageHead, periodSeg, mval, fmtMin, fmtFeat, FEAT, poolGroup, heatStyle, wan, chipConf, jobChip } from "../ui.js";
import { createAction, metricKeyFor } from "../mgmt.js";

const CMP_FEATS = ["first_response_min", "followup_24h_rate", "asked_after_price", "objection_clarified", "proposed_after_intent", "fin_answered", "postvisit_24h", "budget_clarified", "reactivated_by_staff", "escalated"];
const sub = (t, extra = "") => `<h4 class="sub">${esc(t)}${extra ? ` <span class="faint" style="letter-spacing:0;font-weight:400">${extra}</span>` : ""}</h4>`;
const CONF_TXT = { STRONGLY_SUGGESTED: "強烈建議", POSSIBLE: "可能", UNCLEAR: "樣本不足", CONFIRMED: "確定" };
const fv = (k, v) => fmtFeat(k, v);

export async function render(el, ctx) {
  const days = Number(ctx.query.days || 30);
  const rankKey = ctx.query.rank || "closers";
  const r = await api(`/api/staff?days=${days}`);
  if (!r.ok) { el.innerHTML = `<div class="empty">${esc(r.message || "員工效能只開放給老闆與主管。")}</div>`; return; }
  const focusId = r.watch[0]?.staff_id ?? null;
  const prof = focusId ? await api(`/api/staff/${focusId}?days=${days}`) : null;
  const t = r.team, byId = new Map(r.staff.map((s) => [s.id, s]));
  const topStaff = r.compare.top_ids.map((id) => byId.get(id)).filter(Boolean), watchStaff = r.compare.watch_ids.map((id) => byId.get(id)).filter(Boolean);

  /* ── AI 團隊簡報（規則版：每句都是算出來的） ── */
  const brief = [
    `本期 ${num(t.leads)} 位新客戶、成交 ${t.commercial.sold} 台（前期 ${t.prev.sold}）、毛利 ${wan(t.commercial.gp)}（估算，成本知道的 ${t.commercial.gp_known} 台${t.commercial.gp_unknown ? `，${t.commercial.gp_unknown} 台沒有成本未計` : ""}）；成交率 ${pct(t.funnel.close.rate)}（${t.funnel.close.k}/${t.funnel.close.n}），前期 ${pct(t.prev.close.rate)}。`,
    `訊息面指標（回覆、報價後續走、跟進）算「線上回訊息的人」，成交面指標（到店→成交、毛利）算「接待群指派的業務」；共用座位的人只算到團隊。`,
    r.top.length ? `表現最佳：${r.top.map((x) => `${x.name}（${x.reason.split("；")[0]}）`).join("、")}。` : "表現最佳：還沒有人達到樣本門檻。",
    r.watch.length ? `需要關注：${r.watch.map((w) => `${w.name}（${w.issue.text.split("（")[0]}）`).join("、")}。` : "需要關注：目前沒有人明確低於團隊基準。",
    r.compare.summary,
  ];

  /* ── 表現最佳 ── */
  const topCards = r.top.map((x) => `<div class="pcard"><span class="rank">#${x.rank}</span>
    <h4>${esc(x.name)} <span class="faint" style="font-weight:400;font-size:12px">${esc(x.team)}</span> ${jobChip(byId.get(x.staff_id)?.job, byId.get(x.staff_id)?.seat_shared)}</h4>
    <div class="why">關鍵：${esc(x.reason)}</div>
    <div class="g3"><div><span>成交</span> <b>${x.sold} 台</b></div><div><span>成交率</span> <b>${mval(x.close)}</b></div><div><span>影響成交</span> <b>${x.influenced} 台</b></div>
      <div><span>營收</span> <b>${nt(x.revenue)}</b></div><div><span>毛利</span> <b>${nt(x.gp)}</b></div><div><span>每台毛利</span> <b>${x.avg_gp == null ? "—" : nt(x.avg_gp)}</b></div>
      <div><span>預約</span> <b>${x.appts}</b></div><div><span>到店</span> <b>${x.visits}</b></div><div><span>vs 前期</span> <b>${x.trend.sold >= 0 ? "+" : ""}${x.trend.sold} 台</b></div></div>
    <div class="foot"><span class="faint">強項：${esc(x.strength)}</span><span class="sp"></span><a href="/staff/${x.staff_id}" data-link>查看證據 ›</a></div></div>`).join("");

  /* ── 需要關注 ── */
  const watchCards = r.watch.map((w) => `<div class="pcard watch">
    <h4>${esc(w.name)} <span class="faint" style="font-weight:400;font-size:12px">${esc(w.team)} · 成交排名 ${w.rank_closers ?? "不適用"}</span> ${jobChip(byId.get(w.staff_id)?.job, byId.get(w.staff_id)?.seat_shared)}</h4>
    ${byId.get(w.staff_id)?.context.chat_note ? `<div class="faint" style="font-size:12px">${esc(byId.get(w.staff_id).context.chat_note)}</div>` : ""}
    <div class="g3"><div><span>客戶</span> <b>${byId.get(w.staff_id)?.job === "chat" ? byId.get(w.staff_id).context.chat_leads : w.leads}</b></div><div><span>成交</span> <b>${w.sold} 台</b></div><div><span>成交率</span> <b>${mval(w.close)}</b></div>
      <div><span>毛利</span> <b>${nt(w.gp)}</b></div><div><span>最常流失在</span> <b>${esc(w.lost_stage)}</b></div><div><span>流程面流失</span> <b>${w.evidence.process_losses} 位</b></div></div>
    <div class="why"><b style="color:var(--amber)">主要問題</b> ${esc(w.issue.text)}</div>
    <div class="why"><b>觀察到的模式</b> ${esc(w.pattern)}</div>
    <div class="why"><b>建議教練</b> ${esc(w.coaching)}</div>
    <div class="foot"><span class="faint">影響 ${w.evidence.affected_leads} 位客戶</span><a href="/conversations?staff=${encodeURIComponent(w.name)}&outcome=lost" data-link>查看支持對話 ›</a><a href="/staff/${w.staff_id}" data-link>員工檔案 ›</a><span class="sp"></span><button class="btn sm primary" data-coach="${w.staff_id}">建立教練行動</button></div></div>`).join("");

  /* ── 排名（分維度） ── */
  const rk = r.rankings.find((x) => x.key === rankKey) || r.rankings[0];
  const rankSeg = `<div class="seg" id="rankSeg">${r.rankings.map((x) => `<button class="${x.key === rk.key ? "on" : ""}" data-rank="${x.key}">${esc(x.label)}</button>`).join("")}</div>`;
  const rankRows = rk.rows.map((x) => `<tr class="row" data-href="/staff/${x.staff_id}"><td class="num">${x.rank ?? '<span class="faint">資料不足</span>'}</td><td>${esc(x.name)} <span class="faint">${esc(x.team)}</span></td><td class="num">${x.ok ? x.display : `<span class="faint">${x.display}</span>`}</td><td class="num ins">${x.n ? (x.k !== x.n ? `${x.k}/${x.n}` : `n=${x.n}`) : "—"}</td></tr>`).join("");

  /* ── 成功 vs 需關注：行為對照（前端池化，每格附 n）── */
  const cmpRows = CMP_FEATS.map((k) => {
    const a = poolGroup(topStaff, k), b = poolGroup(watchStaff, k), tm = t.behaviors[k]; const tv = tm ? ("rate" in tm ? tm.rate : tm.value) : null; const meta = FEAT[k];
    const enough = a.n >= 5 && b.n >= 5;
    const worse = enough && a.value != null && b.value != null && (meta.unit === "min" ? b.value >= Math.max(30, a.value * 2) : (meta.goodIsUp ? b.value <= a.value - 0.15 : b.value >= a.value + 0.15));
    const gap = !enough ? '<span class="faint">樣本不足</span>' : a.value != null && b.value != null ? (meta.unit === "min" ? `${b.value >= a.value ? "慢" : "快"} ${fmtMin(Math.abs(b.value - a.value))}` : `${b.value >= a.value ? "+" : "−"}${Math.round(Math.abs(b.value - a.value) * 100)} 點`) : "—";
    return `<tr><td>${esc(meta.label)}</td><td class="num">${fv(k, a.value)}<span class="ins">n=${a.n}</span></td><td class="num ${worse ? "dn" : ""}">${fv(k, b.value)}<span class="ins">n=${b.n}</span></td><td class="num">${fv(k, tv)}<span class="ins">n=${tm?.n ?? 0}</span></td><td class="num ${worse ? "dn" : ""}">${gap}</td></tr>`;
  }).join("");
  const funRows = r.compare.funnel.map((f) => `<tr><td>${esc(f.label)}</td><td class="num">${pct(f.top.rate)}<span class="ins">${f.top.k}/${f.top.n}</span></td><td class="num ${f.top.rate != null && f.watch.rate != null && f.watch.rate <= f.top.rate - 0.15 ? "dn" : ""}">${pct(f.watch.rate)}<span class="ins">${f.watch.k}/${f.watch.n}</span></td><td class="num">${pct(f.team.rate)}<span class="ins">${f.team.k}/${f.team.n}</span></td><td class="num">${f.top.rate != null && f.watch.rate != null ? `${f.watch.rate >= f.top.rate ? "+" : "−"}${Math.round(Math.abs(f.watch.rate - f.top.rate) * 100)} 點` : "—"}</td></tr>`).join("");
  const cmpTable = `<table class="tbl dense cmp"><thead><tr><th>行為（同情境才比）</th><th class="num">表現最佳組</th><th class="num">需關注組</th><th class="num">團隊</th><th class="num">需關注 − 最佳</th></tr></thead>
    <tbody>${cmpRows}<tr><td colspan="5" class="faint" style="padding-top:10px">漏斗</td></tr>${funRows}</tbody></table>
    <div class="faint" style="margin-top:8px;font-size:12px">表現最佳組＝${topStaff.map((s) => s.name).join("、") || "—"}；需關注組＝${watchStaff.map((s) => s.name).join("、") || "—"}。這是觀察到的關聯，不是因果；客戶量、車價帶、運氣都可能不同。</div>`;

  /* ── 訊息品質分析（需關注組第一位的真實訊息） ── */
  const ex = prof?.ok ? (prof.plan?.message_examples?.[0] ?? null) : null;
  const msgQuality = ex ? `<div class="ba">
      <div><span class="l">目前訊息 · ${esc(ex.contact)}</span>「${esc(ex.current)}」</div>
      <div class="iss"><span class="l">可能的問題</span>${esc(ex.issue)}</div>
      <div><span class="l">強者的做法</span>${esc(ex.stronger)}</div>
      <div class="sug"><span class="l">建議版本</span>${esc(ex.suggested)}</div>
      <div class="faint" style="font-size:12px">${esc(ex.note)} · <a href="/conversations/${ex.lead_id}#m${ex.message_id}" data-link>看這段對話 ›</a></div></div>`
    : `<div class="empty">需關注組目前沒有可改寫的範例訊息。</div>`;

  /* ── 教練建議（需關注組第一位） ── */
  const plan = prof?.ok ? prof.plan : null;
  const coachCard = plan ? `<div class="plan">
      <div style="font-size:13px;line-height:1.55"><b>主要問題</b> ${plan.main_issue ? esc(plan.main_issue.text) : "沒有明確落後的指標"}</div>
      ${plan.compared.filter((c) => c.worse).length ? `<div class="faint" style="margin:8px 0 4px;font-size:12px">跟${esc(plan.peers_label)}相比</div><ul style="margin:0 0 8px;padding-left:18px;font-size:12.5px;line-height:1.6">${plan.compared.filter((c) => c.worse).slice(0, 3).map((c) => `<li>${esc(c.label)}：${fv(c.feature, c.mine)}（n=${c.n}）vs ${fv(c.feature, c.peers)}</li>`).join("")}</ul>` : ""}
      <div class="faint" style="margin:8px 0 4px;font-size:12px">建議改變</div>
      <ol>${plan.changes.slice(0, 4).map((c) => `<li>${esc(c.text)}<span class="why">${esc(c.why)} · ${chipConf(c.confidence)}</span></li>`).join("")}</ol>
      <div class="faint" style="margin-top:8px;font-size:12px">證據：${plan.evidence.affected_leads} 位受影響客戶 · ${plan.evidence.conversations.length} 段支持對話 · ${esc(plan.evidence.benchmark)}</div>
      <div class="foot" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm primary" data-coach="${plan.staff_id}">建立教練行動</button><a class="btn sm" href="/staff/${plan.staff_id}" data-link>完整檔案 ›</a></div></div>`
    : `<div class="empty">目前沒有需關注的人，教練建議會在有人低於團隊基準時出現。</div>`;

  /* ── 成功模式庫 ── */
  const patRows = r.patterns.filter((p) => p.staff.length || (p.outcome && p.outcome.with.n)).map((p) => `<div class="pat"><b style="min-width:150px">${esc(p.label)}</b><span class="who">${p.staff.length ? p.staff.map((s) => esc(s.name)).join("、") : '<span class="faint">尚無示範者</span>'} <span class="ins">n=${p.n_total}</span></span>
    <span class="num" style="font-size:12.5px">${p.outcome && p.outcome.with.ok && p.outcome.without.ok ? `${pct(p.outcome.with.rate)} vs ${pct(p.outcome.without.rate)}<span class="ins" style="margin-left:4px">${p.outcome.with.n}/${p.outcome.without.n}</span>` : '<span class="faint">關聯樣本不足</span>'}</span>${chipConf(p.confidence)}${p.evidence[0] ? `<a href="/conversations/${p.evidence[0].lead_id}${p.evidence[0].message_id ? `#m${p.evidence[0].message_id}` : ""}" data-link>範例 ›</a>` : ""}</div>`).join("");

  /* ── 流失原因 × 員工 ── */
  const cols = r.matrix.reasons.slice(0, 6);
  const matrix = cols.length ? `<table class="tbl dense heat"><thead><tr><th>業務</th>${cols.map((c) => `<th class="num">${esc(c.label)}</th>`).join("")}<th class="num">n</th></tr></thead><tbody>
    ${r.matrix.rows.filter((row) => row.n > 0).map((row) => `<tr class="row" data-href="/staff/${row.staff_id}"><td>${esc(row.name)}</td>${cols.map((c) => { const cell = row.cells[c.key]; return `<td class="c" style="${heatStyle(cell?.rate ?? null, !!cell?.flag)}">${cell && cell.k ? `${pct(cell.rate)} <span class="ins">${cell.k}</span>` : '<span class="faint">—</span>'}</td>`; }).join("")}<td class="num ins">${row.n}</td></tr>`).join("")}
    <tr><td class="muted">團隊</td>${cols.map((c) => `<td class="num muted">${pct(c.team_rate)} <span class="ins">${c.team_k}</span></td>`).join("")}<td class="num ins">${r.matrix.team_n}</td></tr></tbody></table>
    <div class="faint" style="margin-top:6px;font-size:12px">格＝該人已結案客戶中此原因的比例；琥珀＝比團隊高 10 點以上且 n≥5。</div>` : `<div class="empty">本期沒有流失分析。</div>`;

  /* ── 團隊與財務貢獻 ── */
  const contribCols = [
    { key: "name", label: "員工", render: (s) => `${esc(s.name)} ${jobChip(s.job, s.seat_shared)}` }, { key: "sold", label: "直接成交", num: true, render: (s) => (s.job === "chat" ? '<span class="faint">—</span>' : `${s.commercial.sold}`) }, { key: "infl", label: "影響成交", num: true, render: (s) => `${s.commercial.influenced_sold}` },
    { key: "gp", label: "直接毛利", num: true, render: (s) => (s.job === "chat" ? '<span class="faint">—</span>' : `${nt(s.commercial.gp)}${s.commercial.gp_unknown ? ` <span class="ins">${s.commercial.gp_unknown} 無成本</span>` : ""}`) }, { key: "igp", label: "影響毛利", num: true, render: (s) => nt(s.commercial.influenced_gp) },
    { key: "sup", label: "支援／線上接待", num: true, render: (s) => `${s.activity.supported}` }, { key: "in", label: "接手", num: true, render: (s) => `${s.activity.handoffs_in}` },
    { key: "re", label: "回流", num: true, render: (s) => `${s.activity.reactivations}` }, { key: "mgr", label: "主管介入", num: true, render: (s) => `${s.activity.manager_interventions}` },
  ];
  const contrib = table(contribCols, r.staff, { rowHref: (s) => `/staff/${s.id}`, dense: true, empty: "沒有資料" });

  /* ── 團隊效能與協作 ── */
  const teamCols = [{ key: "name", label: "組別" }, { key: "staff", label: "人數", num: true }, { key: "leads", label: "客戶", num: true }, { key: "sold", label: "成交", num: true }, { key: "close", label: "成交率", num: true, render: (x) => mval(x.close) }, { key: "gp", label: "毛利", num: true, render: (x) => nt(x.gp) }, { key: "handoff_success", label: "交接後成交", num: true, render: (x) => mval(x.handoff_success) }, { key: "cross_support", label: "跨組支援", num: true }];
  const pairs = r.pairs.length ? `<ul class="acts">${r.pairs.slice(0, 8).map((p) => `<li class="act"><b>${esc(p.a)} + ${esc(p.b)}</b><span class="muted">${p.cases} 件共同案 · ${p.sold} 台成交${p.rate != null ? ` · ${pct(p.rate)}` : ""}</span>${chip("關聯")}</li>`).join("")}</ul>` : `<div class="faint" style="font-size:12.5px">本期沒有兩人以上共同參與的案子（≥2 件才列）。</div>`;

  /* ── 員工比較表 ── */
  const cmpCols = [
    { key: "name", label: "員工" }, { key: "job", label: "性質", render: (s) => jobChip(s.job, s.seat_shared) }, { key: "team", label: "組別" }, { key: "leads", label: "客戶", num: true, render: (s) => (s.job === "chat" ? `${s.context.chat_leads} <span class="ins">線上</span>` : `${s.context.leads}`) },
    { key: "sold", label: "成交", num: true, render: (s) => `${s.commercial.sold}` }, { key: "close", label: "成交率", num: true, render: (s) => mval(s.funnel.close), cls: (s) => (s.funnel.close.ok && t.funnel.close.rate != null && s.funnel.close.rate != null && s.funnel.close.rate <= t.funnel.close.rate - 0.1 ? "warn" : "") },
    { key: "gp", label: "直接毛利", num: true, render: (s) => nt(s.commercial.gp) }, { key: "igp", label: "影響毛利", num: true, render: (s) => nt(s.commercial.influenced_gp) },
    { key: "pc", label: "報價後續走", num: true, render: (s) => mval(s.funnel.price_continue), cls: (s) => (s.funnel.price_continue.ok && t.funnel.price_continue.rate != null && s.funnel.price_continue.rate <= t.funnel.price_continue.rate - 0.1 ? "warn" : "") },
    { key: "appt", label: "預約轉換", num: true, render: (s) => mval(s.funnel.appt) }, { key: "av", label: "預約→到店", num: true, render: (s) => mval(s.funnel.appt_visit) }, { key: "vs", label: "到店→成交", num: true, render: (s) => mval(s.funnel.visit_sale) },
    { key: "fr", label: "首次回覆", num: true, render: (s) => mval(s.activity.first_response, fmtMin), cls: (s) => (s.activity.first_response.ok && t.activity.first_response.value != null && s.activity.first_response.value >= Math.max(30, t.activity.first_response.value * 2) ? "warn" : "") },
    { key: "fu", label: "沉默後跟進", num: true, render: (s) => mval(s.activity.followup_24h) }, { key: "re", label: "回流", num: true, render: (s) => mval(s.activity.reactivation_rate) },
    { key: "band", label: "車價帶", render: (s) => esc(s.context.band) },
  ];

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("員工效能", r.top.length ? `表現最佳：${r.top.map((x) => x.name).join("、")}；需關注：${r.watch.map((w) => w.name).join("、") || "無"}` : "還沒有人達到樣本門檻", `<span class="faint" style="margin-right:10px">成功 vs 需關注 · 最近 ${days} 天</span>${periodSeg(days, (dd) => ctx.nav(`/staff?days=${dd}&rank=${rk.key}`))}`)}
    <div class="two">
      <div class="stack">
        <section class="panel brief"><h3>AI 團隊簡報 <span class="faint" style="letter-spacing:0;font-weight:400">規則版 · 每句都是算出來的</span></h3>${brief.map((b) => `<p>${esc(b)}</p>`).join("")}</section>
        <section><div class="ph" style="margin-bottom:6px"><h3 class="muted" style="margin:0;font-weight:500;letter-spacing:.06em">表現最佳 · TOP PERFORMERS</h3><span class="faint">依成交率 Wilson 下界排序，已結案 ≥10 才進榜</span></div>
          ${r.top.length ? `<div class="grid g3">${topCards}</div>` : '<div class="panel empty">還沒有人達到樣本門檻。</div>'}</section>
        <section><div class="ph" style="margin-bottom:6px"><h3 class="muted" style="margin:0;font-weight:500;letter-spacing:.06em">需要關注 · PERFORMANCE WATCH</h3><span class="faint">樣本夠、且明確低於團隊基準的人；不是排名，是教練清單</span></div>
          ${r.watch.length ? `<div class="grid g2">${watchCards}</div>` : '<div class="panel empty">目前沒有人明確低於團隊基準。</div>'}</section>
        <section class="panel"><h3>排名 <span class="faint" style="letter-spacing:0;font-weight:400">${esc(rk.desc)}</span></h3>${rankSeg}
          <table class="tbl dense"><thead><tr><th class="num">名次</th><th>業務</th><th class="num">${esc(rk.label)}</th><th class="num">樣本</th></tr></thead><tbody>${rankRows}</tbody></table></section>
        <section class="panel"><h3>成功 vs 需關注 · 行為對照</h3>${cmpTable}</section>
        <section class="panel"><h3>訊息品質分析 <span class="faint" style="letter-spacing:0;font-weight:400">${ex ? `${esc(prof.staff.name)} 的真實訊息` : ""}</span></h3>${msgQuality}</section>
      </div>
      <div class="stack">
        <section class="panel"><h3>教練建議 ${plan ? `<span class="faint" style="letter-spacing:0;font-weight:400">· ${esc(plan.name)} · ${plan.model === "template" ? "規則版" : esc(plan.model)}</span>` : ""}</h3>${coachCard}</section>
        <section class="panel" id="patterns"><h3>成功模式庫 <span class="faint" style="letter-spacing:0;font-weight:400">有做到 vs 沒做到的成交率（關聯）</span></h3>${patRows || '<div class="empty">還沒有樣本足夠的模式。</div>'}</section>
        <section class="panel"><h3>流失原因 × 員工</h3>${matrix}</section>
        <section class="panel"><h3>團隊與財務貢獻 <span class="faint" style="letter-spacing:0;font-weight:400">影響＝以任一角色出現的成交案，每案算一次</span></h3>${contrib}</section>
      </div>
    </div>
    <section class="panel" id="teams"><h3>團隊效能</h3><div class="grid g2"><div>${table(teamCols, r.teams, { dense: true, empty: "沒有組別資料" })}</div><div>${sub("常一起出現在成交案的組合", "關聯，不是歸因")}${pairs}</div></div></section>
    <section class="panel"><h3>員工比較 <span class="faint" style="letter-spacing:0;font-weight:400">每格附樣本；琥珀＝明確低於團隊</span></h3>${table(cmpCols, r.staff, { rowHref: (s) => `/staff/${s.id}`, dense: true, empty: "沒有員工資料" })}</section>
  </div>`;

  bindRows(el);
  el.querySelectorAll("#rankSeg button").forEach((b) => b.onclick = () => ctx.nav(`/staff?days=${days}&rank=${b.dataset.rank}`));
  el.querySelectorAll("[data-coach]").forEach((b) => b.onclick = async () => {
    const id = Number(b.dataset.coach); const w = r.watch.find((x) => x.staff_id === id); const iss = w ? w.issue : (r.issues[id] || [])[0];
    if (!iss) return;
    b.disabled = true;
    await createAction({ kind: "coach", title: `教練 ${w?.name || byId.get(id)?.name}：${iss.text.split("（")[0]}`, staff_id: id, priority: "high", metric_key: metricKeyFor(iss.key), why: iss.text, measure: `接下來 30 天的${iss.key === "response" ? "首次回覆時間" : iss.key === "followup" ? "沉默後跟進率" : iss.key === "price_continue" ? "報價後續走率" : "該指標"}`, action: w?.coaching || "" });
    b.textContent = "已建立 · 到決策中心看";
  });
}
