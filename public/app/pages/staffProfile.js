/* 員工檔案：指標 → 漏斗 → 營收／毛利 → 流失原因 → 行為對照 → 教練計畫（含訊息改寫範例）→ 證據（本期客戶）。
   每個數字附樣本；本人若在表現最佳組，對照的是「其他同事」。 */
import { api } from "../api.js";
import { esc, pct, nt, num, chip, table, bindRows, fmtD, mval, fmtMin, fmtFeat, chipConf, wan, lossLabel, DRIVER, STAGE_TXT, roleLabel, toast, periodSeg, jobChip } from "../ui.js";
import { createAction, metricKeyFor } from "../mgmt.js";

const kv = (rows) => `<div class="kv">${rows.map(([k, v]) => `<div>${esc(k)}</div><div>${v}</div>`).join("")}</div>`;
const OUT = { sold: "成交", lost: "流失", "": "進行中" };

export async function render(el, ctx) {
  const id = Number(ctx.params.id); const days = Number(ctx.query.days || 30);
  const r = await api(`/api/staff/${id}?days=${days}${ctx.query.refresh ? "&refresh=1" : ""}`);
  if (!r.ok) { el.innerHTML = `<div class="empty">${esc(r.message || "找不到這位員工。")}</div>`; return; }
  const s = r.staff, t = r.team, p = r.plan, isTop = r.top_ids.includes(id), isWatch = r.watch_ids.includes(id);
  const cmp = (mine, team, fmt = pct) => `${mval(mine, fmt)} <span class="faint">團隊 ${fmt(("rate" in team) ? team.rate : team.value)}</span>`;
  const roleCount = Object.fromEntries((r.roles || []).map((x) => [x.role, x.n]));
  const rankChips = r.rankings.filter((x) => x.rank).sort((a, b) => a.rank - b.rank).slice(0, 4).map((x) => chip(`${x.label} 第 ${x.rank}／${x.of}`, x.rank <= 2 ? "cyan" : "")).join(" ");

  const head = `<div class="ph"><div><div class="faint" style="font-size:12px;margin-bottom:4px"><a href="/staff" data-link>員工效能</a> › 檔案</div>
      <h1>${esc(s.name)} ${jobChip(s.job, s.seat_shared)} <span class="faint" style="font-size:14px;font-weight:400">${esc(s.team)} · ${esc(s.context.band)}${isTop ? " · " + chip("表現最佳", "cyan") : isWatch ? " · " + chip("需要關注", "amber") : ""}</span></h1></div>
      <span class="sp"></span>${periodSeg(days, (dd) => ctx.nav(`/staff/${id}?days=${dd}`))}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${rankChips || '<span class="faint">還沒有進榜的維度（樣本不足）</span>'}${s.context.peer_note ? `<span class="faint" style="font-size:12px">· ${esc(s.context.peer_note)}</span>` : ""}${s.context.chat_note ? `<span class="faint" style="font-size:12px">· ${esc(s.context.chat_note)}</span>` : ""}</div>`;

  const activity = kv([
    ["處理客戶", `${s.job === "chat" ? `${s.context.chat_leads} 位 <span class="faint">線上回覆</span>` : `${s.context.leads} 位`} <span class="faint">進行中 ${s.context.open}、已結案 ${s.context.closed}${s.job !== "chat" && s.context.chat_leads !== s.context.leads ? `、線上回覆 ${s.context.chat_leads}` : ""}</span>`],
    ["進行中對話", `${s.activity.active_conversations} <span class="faint">停滯（14 天無業務訊息）${s.activity.stale}</span>`],
    ["首次回覆中位數", cmp(s.activity.first_response, t.activity.first_response, fmtMin)],
    ["回覆中位數", cmp(s.activity.response, t.activity.response, fmtMin)],
    ["沉默後 24h 跟進", cmp(s.activity.followup_24h, t.activity.followup_24h)],
    ["交接", `交出 ${s.activity.handoffs_out} · 接手 ${s.activity.handoffs_in}`],
    ["回流", `${mval(s.activity.reactivation_rate)} <span class="faint">沉默客戶被叫回來</span>`],
  ]);
  const funnel = kv([
    ["報價後續走", cmp(s.funnel.price_continue, t.funnel.price_continue)], ["預約轉換", cmp(s.funnel.appt, t.funnel.appt)],
    ["預約→到店", cmp(s.funnel.appt_visit, t.funnel.appt_visit)], ["到店→成交", cmp(s.funnel.visit_sale, t.funnel.visit_sale)],
    ["成交率", cmp(s.funnel.close, t.funnel.close)], ["流失率", cmp(s.funnel.dropoff, t.funnel.dropoff)],
  ]);
  const commercial = kv([
    ["成交", `${s.commercial.sold} 台 <span class="faint">前期 ${s.prev.sold}</span>`], ["營收", nt(s.commercial.revenue)],
    ["毛利", `${nt(s.commercial.gp)}${s.commercial.gp_estimate ? ` ${chip("估算", "est")}` : ""} <span class="faint">毛利率 ${pct(s.commercial.margin)} · 前期 ${wan(s.prev.gp)}${s.commercial.gp_unknown ? ` · ${s.commercial.gp_unknown} 台無成本未計` : ""}</span>`],
    ["影響成交／毛利", `${s.commercial.influenced_sold} 台 · ${nt(s.commercial.influenced_gp)} ${chip("關聯")}`],
    ["平均售價", s.commercial.avg_price == null ? "—" : nt(s.commercial.avg_price)], ["每台毛利", mval(s.commercial.avg_gp, (v) => (v == null ? "—" : nt(v)))],
    ["平均成交天數", s.commercial.avg_days == null ? "—" : `${s.commercial.avg_days} 天`], ["折讓／低於成本", `${mval(s.commercial.discount, (v) => (v == null ? "—" : pct(v, 1)))} · ${s.commercial.below_cost} 筆`],
  ]);
  const collab = kv([
    ["支援別人的案子", `${s.activity.supported} <span class="faint">跨組 ${s.activity.cross_team_support}</span>`], ["主管介入我的案子", `${s.activity.manager_interventions}`],
    ["角色統計", Object.entries(roleCount).map(([k, n]) => `${roleLabel(k)} ${n}`).join(" · ") || "—"],
    ["協作組合", r.pairs.length ? r.pairs.map((x) => `${esc(x.a === s.name ? x.b : x.a)} ${x.cases} 件${x.rate != null ? `（${pct(x.rate)}）` : ""}`).join("、") : "—"],
  ]);

  const lossRows = s.loss.reasons.map((x) => { const team = t.loss.reasons.find((y) => y.key === x.key); const flag = s.loss.n >= 5 && team?.rate != null && x.rate != null && x.rate >= team.rate + 0.1;
    return `<div class="lossrow"><div><b>${esc(x.label)}</b> <span class="ins">${x.k}/${s.loss.n}</span><div class="bar" style="margin-top:4px"><i class="${flag ? "warn" : ""}" style="width:${Math.round((x.rate ?? 0) * 100)}%"></i></div></div><div class="num ${flag ? "warn" : ""}">${pct(x.rate)} <span class="faint">團隊 ${pct(team?.rate)}</span></div></div>`; }).join("");
  const lossBox = s.loss.n ? `${lossRows}<div class="faint" style="margin-top:8px;font-size:12px">最常掉在：${s.loss.stages.map((x) => `${x.label} ${x.k}`).join("、")} · 客戶面 ${s.loss.driver.customer}／流程面 ${s.loss.driver.process}／不明 ${s.loss.driver.unclear}</div>` : '<div class="empty">本期沒有流失客戶。</div>';

  const cmpRows = (p?.compared || []).map((c) => `<tr><td>${esc(c.label)}</td><td class="num ${c.worse ? "dn" : ""}">${fmtFeat(c.feature, c.mine)}<span class="ins">n=${c.n}</span></td><td class="num">${fmtFeat(c.feature, c.peers)}<span class="ins">n=${c.peers_n}</span></td><td class="num">${fmtFeat(c.feature, c.team)}</td></tr>`).join("");
  const cmpTable = p ? `<table class="tbl dense cmp"><thead><tr><th>行為（同情境才比）</th><th class="num">本人</th><th class="num">${esc(p.peers_label)}</th><th class="num">團隊</th></tr></thead><tbody>${cmpRows}</tbody></table>` : "";

  const planBox = p ? `<div class="plan">
      <div style="font-size:13px;line-height:1.55"><b>主要問題</b> ${p.main_issue ? esc(p.main_issue.text) + `（影響 ${p.main_issue.affected} 位客戶）` : "沒有明確落後的指標"}</div>
      ${p.changes.length ? `<div class="faint" style="margin:10px 0 4px;font-size:12px">建議改變（改什麼 · 為什麼 · 證據 · 像哪個模式 · 把握）</div><ol>${p.changes.map((c) => `<li>${esc(c.text)}<span class="why">為什麼：${esc(c.why)}</span><span class="why">證據：${esc(c.evidence)} · 模式：${esc(c.pattern)} · ${chipConf(c.confidence)}</span></li>`).join("")}</ol>` : '<p class="faint" style="font-size:13px">沒有明顯落後的行為，先維持。</p>'}
      ${p.strengths.length ? `<div class="faint" style="margin:10px 0 4px;font-size:12px">強項</div><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6">${p.strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${p.insufficient.length ? `<div class="faint" style="margin:10px 0 0;font-size:12px">資料不足：${p.insufficient.map(esc).join("；")}</div>` : ""}
      <div class="faint" style="margin-top:8px;font-size:12px">基準：${esc(p.evidence.benchmark)} · 產生於 ${fmtD(p.generated_at)} · ${p.model === "template" ? "規則版" : esc(p.model) + " 潤稿"}</div>
    </div>` : '<div class="empty">還沒有教練計畫。</div>';
  const examples = (p?.message_examples || []).map((e) => `<div class="ba"><div><span class="l">目前訊息 · ${esc(e.contact)} · ${{ price: "報價", financing: "貸款", objection: "價格異議", postvisit: "到店後" }[e.kind] || esc(e.kind)}</span>「${esc(e.current)}」</div><div class="iss"><span class="l">可能的問題</span>${esc(e.issue)}</div><div><span class="l">強者的做法</span>${esc(e.stronger)}</div><div class="sug"><span class="l">建議版本</span>${esc(e.suggested)}</div><div class="faint" style="font-size:12px">${esc(e.note)} · <a href="/conversations/${e.lead_id}#m${e.message_id}" data-link>看這段對話 ›</a></div></div>`).join('<div style="height:10px"></div>');

  const leadCols = [
    { key: "opened_at", label: "進線", render: (x) => fmtD(x.opened_at) }, { key: "contact", label: "客戶" }, { key: "vehicle", label: "車款" },
    { key: "outcome", label: "結果", render: (x) => chip(OUT[x.outcome] ?? x.outcome, x.outcome === "sold" ? "cyan" : "") },
    { key: "primary_reason", label: "流失原因", render: (x) => (x.primary_reason ? `${esc(lossLabel(x.primary_reason))} <span class="faint">${DRIVER[x.driver] || ""} · ${STAGE_TXT[x.lost_stage] || ""}後</span>` : x.outcome === "sold" ? `<span class="faint">毛利 ${x.cost_source === "none" ? "無成本" : x.gross_profit == null ? "—" : `${nt(x.gross_profit)}${x.gp_is_estimate ? "（估算）" : ""}`}</span>` : "—") },
  ];

  el.innerHTML = `<div class="wrap stack">${head}
    <div class="two">
      <div class="stack">
        <section class="grid g2"><div class="panel"><h3>活動</h3>${activity}</div><div class="panel"><h3>漏斗</h3>${funnel}</div></section>
        <section class="grid g2"><div class="panel"><h3>營收與毛利</h3>${commercial}</div><div class="panel"><h3>協作</h3>${collab}</div></section>
        <section class="panel"><h3>行為對照 <span class="faint" style="letter-spacing:0;font-weight:400">琥珀＝明確落後（比例差 15 點、回覆時間 2 倍以上）；觀察到的關聯</span></h3>${cmpTable}</section>
        <section class="panel"><h3>本期客戶 <span class="faint" style="letter-spacing:0;font-weight:400">${r.leads.length} 位 · 點一列開對話</span></h3>${table(leadCols, r.leads, { rowHref: (x) => `/conversations/${x.id}`, dense: true, empty: "本期沒有客戶" })}</section>
      </div>
      <div class="stack">
        <section class="panel"><h3>教練計畫 <span class="sp"></span><button class="btn sm" id="regen">重新產生（AI 潤稿）</button></h3>${planBox}
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${p?.main_issue ? `<button class="btn sm primary" id="mkAction">建立教練行動</button>` : ""}<a class="btn sm" href="/ask?q=${encodeURIComponent(`${s.name}該怎麼改進他的客戶訊息？`)}" data-link>問 AI 怎麼改 ›</a></div></section>
        <section class="panel"><h3>訊息改寫範例 <span class="faint" style="letter-spacing:0;font-weight:400">教練建議，不會自動發送</span></h3>${examples || '<div class="empty">沒有可改寫的範例（沒有出現弱訊息的情境）。</div>'}</section>
        <section class="panel"><h3>流失原因 <span class="faint" style="letter-spacing:0;font-weight:400">本期 ${s.loss.n} 位 · 對照團隊</span></h3>${lossBox}</section>
        ${r.patterns.length ? `<section class="panel"><h3>示範的成功模式</h3><div style="display:flex;gap:6px;flex-wrap:wrap">${r.patterns.map((x) => chip(x.label, "cyan")).join("")}</div></section>` : ""}
      </div>
    </div>
  </div>`;
  bindRows(el);
  const regen = el.querySelector("#regen");
  if (regen) regen.onclick = async () => { regen.disabled = true; regen.textContent = "產生中…（AI 約 10 秒）"; const x = await api(`/api/coaching/${id}`, { days }); toast(x.ok ? `教練計畫已更新（${x.plan.model === "template" ? "規則版" : "AI 潤稿"}）` : (x.message || "失敗")); render(el, ctx); };
  const mk = el.querySelector("#mkAction");
  if (mk) mk.onclick = async () => { mk.disabled = true; const iss = p.main_issue; await createAction({ kind: "coach", title: `教練 ${s.name}：${iss.text.split("（")[0]}`, staff_id: id, priority: "high", metric_key: metricKeyFor(iss.key), why: iss.text, measure: "接下來 30 天的同一指標", action: p.changes[0]?.text || iss.coaching }); mk.textContent = "已建立 · 到決策中心看"; };
}
