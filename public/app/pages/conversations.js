/* 對話與證據：左清單／中時間軸（事件插在訊息之間、證據高亮）／右 AI 分析（事實與假設分開）。 */
import { api } from "../api.js";
import { h, raw, esc, fmtDT, fmtD, ago, chipStage, chipGrade, GRADE, chip, chipClaim, chipConf, bubble, eventMark, EVENT, CONF, STAGE, wan, toast, lossLabel, DRIVER, roleLabel, lostReason, coverageChip, MATCH, nt } from "../ui.js";
const LABEL_NAME = { grade: "SABC 分級", PRICE_MENTIONED: "業務報價", PRICE_DROP_OFF: "報價後流失", APPOINTMENT_PROPOSED: "提議看車", APPOINTMENT_BOOKED: "預約成立", HIGH_INTENT: "急迫", FINANCING_QUESTION: "問貸款", financing_resolved: "貸款有答", SOLD: "成交", result_tag: "結果標籤" };

const FLAG = { price_dropoff: "價格後流失", high_intent: "高意圖", financing: "貸款未回", insights: "有洞察的" };

export async function render(el, ctx) {
  const q = ctx.query, cur = ctx.params.id ? Number(ctx.params.id) : null;
  const qs = new URLSearchParams(); for (const k of ["q", "stage", "staff", "vehicle", "outcome", "flag", "insight", "event", "grade", "tag"]) if (q[k]) qs.set(k, q[k]);
  const [list, detail] = await Promise.all([api(`/api/leads?${qs}&limit=80`), cur ? api(`/api/leads/${cur}`) : Promise.resolve(null)]);
  const leads = list.leads || [];
  const staffs = [...new Set(leads.map((l) => l.staff).filter(Boolean))], vehicles = [...new Set(leads.map((l) => l.vehicle).filter(Boolean))];
  const opt = (arr, sel, label) => `<option value="">${label}</option>` + arr.map((v) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(v)}</option>`).join("");

  const listHtml = leads.length ? leads.map((l) => h`<a href="/conversations/${l.id}${qs.toString() ? "?" + qs : ""}" data-link class="${l.id === cur ? "on" : ""} ${l.flags.price_dropoff ? "pd" : l.flags.high_intent ? "hi" : ""}">
      <div class="n"><span>${l.pseudonym} <span class="faint">${l.staff ? "· " + l.staff : ""}</span></span><span class="faint">${ago(l.last_at)}</span></div>
      <div class="s">${raw(chipGrade(l.grade_auto, l.grade_reason))}${l.vehicle}${raw(chipStage(l.stage))}${l.flags.price_dropoff ? raw(chip("價格後流失", "amber")) : ""}${l.flags.financing_unresolved ? raw(chip("貸款未回")) : ""}</div>
    </a>`).join("") : '<div class="empty">沒有符合的對話。</div>';

  el.innerHTML = h`<div class="conv">
    <section class="panel clist">
      <h3>對話 <span class="faint" style="letter-spacing:0;font-weight:400">${list.n ?? 0} 則</span>${q.insight ? raw(h`<a href="/insights/${q.insight}" data-link style="font-weight:400;letter-spacing:0">‹ 回洞察</a>`) : ""}</h3>
      <input id="fq" placeholder="搜尋客戶或車款…" value="${q.q || ""}">
      <div class="filters">
        <select id="fgrade"><option value="">分級</option>${raw(["S", "A", "B", "C"].map((g) => `<option value="${g}" ${q.grade === g ? "selected" : ""}>${GRADE[g]}</option>`).join(""))}</select>
        <select id="fstage">${raw(opt(Object.keys(STAGE), q.stage, "階段"))}</select>
        <select id="fstaff">${raw(opt(staffs, q.staff, "業務"))}</select>
        <select id="fveh">${raw(opt(vehicles, q.vehicle, "車款"))}</select>
        <select id="fout"><option value="">結果</option><option value="open" ${q.outcome === "open" ? "selected" : ""}>進行中</option><option value="sold" ${q.outcome === "sold" ? "selected" : ""}>成交</option><option value="lost" ${q.outcome === "lost" ? "selected" : ""}>流失</option></select>
        <select id="fflag">${raw(opt(Object.keys(FLAG), q.flag, "只看…"))}</select>
      </div>
      ${raw(listHtml)}
    </section>
    <section class="panel" id="thread">${raw(cur ? threadHtml(detail) : '<div class="empty" style="text-align:center;padding:80px 0">從左邊選一位客戶，看完整對話與系統偵測到的事件。</div>')}</section>
    <section class="panel" id="side">${cur && detail?.ok ? raw(sideHtml(detail)) : ""}</section>
  </div>`;

  // 篩選：改任何一個就重新載入（保留目前的對話）
  const go = () => { const p = new URLSearchParams(); const v = (id) => document.getElementById(id).value; if (v("fq")) p.set("q", v("fq")); if (v("fstage")) p.set("stage", v("fstage")); if (v("fgrade")) p.set("grade", v("fgrade")); if (v("fstaff")) p.set("staff", v("fstaff")); if (v("fveh")) p.set("vehicle", v("fveh")); if (v("fout")) p.set("outcome", v("fout")); if (v("fflag")) p.set("flag", v("fflag")); if (q.insight) p.set("insight", q.insight); ctx.nav(`/conversations${cur ? "/" + cur : ""}${p.toString() ? "?" + p : ""}`); };
  ["fgrade", "fstage", "fstaff", "fveh", "fout", "fflag"].forEach((id) => document.getElementById(id).onchange = go);
  document.getElementById("fq").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  document.getElementById("fflag").innerHTML = `<option value="">只看…</option>` + Object.entries(FLAG).map(([k, v]) => `<option value="${k}" ${q.flag === k ? "selected" : ""}>${v}</option>`).join("");
  el.querySelectorAll("[data-act]").forEach((b) => b.onclick = async () => { const r = await api(`/api/actions/${b.dataset.act}`, { status: b.dataset.st }, "PATCH"); toast(r.ok ? "已更新" : "失敗"); render(el, ctx); });
  // 捲到指定訊息（從證據頁跳過來）
  if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ block: "center" }), 60);
  else if (cur) { const t = document.getElementById("thread"); t.scrollTop = t.scrollHeight; }
}

function threadHtml(d) {
  if (!d?.ok) return `<div class="empty">${esc(d?.message || "讀不到這筆對話。")}</div>`;
  const notes = new Map();   // message_id → note（事件證據＋洞察證據）
  for (const e of d.events) for (const x of e.evidence) if (x.message_id && !notes.has(x.message_id)) notes.set(x.message_id, x.note || EVENT[e.type]);
  for (const i of d.insights) for (const x of i.evidence) if (x.message_id && !notes.has(x.message_id)) notes.set(x.message_id, x.note || i.title);
  if (d.loss) for (const x of d.loss.evidence || []) if (x.message_id && !notes.has(x.message_id)) notes.set(x.message_id, `流失證據：${x.note}`);
  // 事件與訊息合併成一條時間軸；同一時間事件排在訊息後面
  const items = [...d.messages.map((m) => ({ t: Date.parse(m.created_at), k: 0, m })), ...d.events.filter((e) => !["NEW_LEAD", "VEHICLE_INTEREST", "ACTIVE_DISCUSSION"].includes(e.type)).map((e) => ({ t: Date.parse(e.at), k: 1, e }))]
    .sort((a, b) => a.t - b.t || a.k - b.k);
  const L = d.lead;
  return `<h3>${esc(L.pseudonym)} <span class="faint" style="letter-spacing:0;font-weight:400">${esc(L.display_name)} · ${esc(L.vehicle)} · 業務 ${esc(L.staff || "未指派")}</span> ${coverageChip(L.coverage, L.coverage_note)}</h3>
    <div class="thread">${items.map((x) => x.m ? bubble(x.m, { evidence: notes.get(x.m.id) || null }) : eventMark(x.e)).join("")}</div>`;
}

function sideHtml(d) {
  const L = d.lead, ev = d.events;
  const find = (t) => ev.find((e) => e.type === t && e.confidence !== "UNCLEAR");
  const price = find("PRICE_MENTIONED"), drop = find("PRICE_DROP_OFF"), obj = find("PRICE_OBJECTION"), neg = find("NEGOTIATION"), fin = find("FINANCING_QUESTION");
  const booked = find("APPOINTMENT_BOOKED"), noshow = find("NO_SHOW"), visit = find("STORE_VISIT"), sold = find("SOLD"), lost = find("LOST"), hi = find("HIGH_INTENT"), inactive = [...ev].reverse().find((e) => e.type === "CUSTOMER_INACTIVE");
  const fus = ev.filter((e) => e.type === "FOLLOW_UP").length;

  /* 事實：從事件直接組句子，沒有任何推測 */
  const facts = [];
  facts.push(`${fmtD(L.opened_at)} 進線${L.vehicle ? `，問 ${L.vehicle}` : ""}。`);
  if (price) facts.push(`${fmtD(price.at)} 業務報價${price.detail?.price_wan ? ` ${price.detail.price_wan} 萬` : ""}。`);
  if (obj) facts.push(`客戶對價格表達異議。`);
  if (neg) facts.push(`客戶出價${neg.detail?.counter_wan ? ` ${neg.detail.counter_wan} 萬` : ""}，進入議價。`);
  if (fin) facts.push(`客戶問了貸款，業務${fin.detail?.resolved ? "有" : "沒有"}給具體答案。`);
  if (booked) facts.push(`${fmtD(booked.at)} 預約成立。`);
  if (noshow) facts.push(`預約時間過了沒有到店。`);
  if (visit) facts.push(`${fmtD(visit.at)} 到店${visit.detail?.source === "reception" ? "（接待群紀錄）" : ""}。`);
  if (drop) facts.push(`報價後客戶${drop.detail?.pattern === "silent" ? "沒有再回覆" : drop.detail?.pattern === "objection_then_silent" ? "先異議、之後沉默" : "回覆明顯變慢"}（價格後流失 · ${CONF[drop.confidence]}）。`);
  if (fus) facts.push(`業務主動跟進 ${fus} 次。`);
  if (sold) facts.push(`${fmtD(sold.at)} 成交${sold.detail?.gross_profit != null ? `，毛利 ${wan(sold.detail.gross_profit)}${sold.detail?.gp_estimate ? "（估算）" : ""}` : "，沒有成本所以毛利不算"}${sold.detail?.source_kind === "peer" ? "，同行的車" : ""}。`);
  if (L.coverage && L.coverage !== "full") facts.push(`這段對話的訊息涵蓋不完整（${esc(L.coverage_note)}），回覆速度與跟進不列入評估。`);
  else if (lost) facts.push(`${lost.detail?.inferred ? `沉默 ${lost.detail.silent_days} 天，推定流失` : `${fmtD(lost.at)} 流失${lost.detail?.reason ? `（${lostReason(lost.detail.reason)}）` : ""}`}。`);
  else if (inactive) facts.push(`客戶已沉默 ${inactive.detail?.silent_days ?? "7+"} 天。`);

  /* 假設：解讀，標明 */
  const hypo = [];
  if (hi) hypo.push(`客戶早期說「${esc(hi.detail?.phrase || "")}」，購買意圖可能偏高。`);
  if (drop?.detail?.pattern === "silent") hypo.push("報價後完全沒回，可能是價格超出預期，或去比價了。");
  if (drop?.detail?.pattern === "objection_then_silent") hypo.push("先講貴再消失，價格是主要障礙的可能性高。");
  if (drop?.detail?.pattern === "slower_reply") hypo.push("報價後回覆變慢，可能在猶豫或比較其他車。");
  if (fin && !fin.detail?.resolved) hypo.push("貸款沒有得到具體數字，客戶可能還在算得不得起。");
  if (noshow) hypo.push("爽約但沒有明說原因，可能不是不想買而是時間安排。");
  if (!hypo.length) hypo.push("目前沒有足夠的訊號做進一步解讀。");

  /* 建議下一步：先用洞察的動作，沒有就用規則 */
  const proposed = d.actions.filter((a) => a.status !== "dismissed");
  const next = proposed.length ? proposed.map((a) => a.text)
    : drop && !sold && !lost ? ["補一則詢問疑慮的訊息，或提供預算內的替代車款。"]
    : fin && !fin.detail?.resolved ? ["直接給頭期／月付數字，或 24 小時內轉貸款專員。"]
    : noshow ? ["確認狀況並提供兩個新時段。"]
    : booked && !visit && !sold ? ["預約前一天發確認訊息。"]
    : sold ? ["交車後 7 天關懷一次，順便問轉介。"] : ["維持跟進節奏，48 小時內至少一則主動訊息。"];

  return `<div class="kv"><div>客戶</div><div><b>${esc(L.pseudonym)}</b> <span class="faint">${esc(L.display_name)}</span></div>
      <div>分級</div><div>${chipGrade(L.grade_auto, L.grade_reason)} <span class="faint">${esc(L.grade_reason || "")}</span>${L.result_tag ? ` ${chip(L.result_tag, "amber")}` : ""}${L.grade ? ` <span class="faint">· 訊息組標 ${esc(L.grade)}</span>` : ""}</div><div>首次進線</div><div>${fmtD(L.first_contact_at || L.opened_at)}</div>
      <div>車款</div><div>${esc(L.vehicle || "—")}${L.list_price ? ` <span class="faint">開價 ${wan(L.list_price)}</span>` : ""}${L.sell_price ? ` <span class="faint">調作價 ${wan(L.sell_price)}</span>` : ""}</div>
      <div>業務</div><div>${esc(L.staff || "未指派")}${(d.roles || []).filter((r) => r.role !== "primary").map((r) => ` ${chip(`${roleLabel(r.role)} ${r.staff}`, r.role === "chat_handler" ? "cyan" : "")}`).join("")}</div><div>階段</div><div>${chipStage(L.stage)} ${L.outcome ? chip({ sold: "已成交", lost: "已流失" }[L.outcome], L.outcome === "sold" ? "cyan" : "") : ""}</div>
      <div>訊息涵蓋</div><div>${L.coverage && L.coverage !== "full" ? `${coverageChip(L.coverage, L.coverage_note)} <span class="faint">${esc(L.coverage_note)}</span>` : "完整"}</div></div>
    <div class="aibox linked"><h4>${chipClaim("fact")} 摘要</h4><p>${facts.join("")}</p></div>
    <div class="aibox"><h4>${chipClaim("hypothesis")} 異議與意圖</h4><p>${hypo.join("")}</p></div>
    ${(d.appraisals || []).length ? `<div class="aibox"><h4>估車 ${chip((d.appraisals[0].mode === "trade_in" ? "車換車" : d.appraisals[0].mode === "sell" ? "純賣" : "—"))}</h4>
      <p>${esc(d.appraisals[0].model_text || "舊車")}${d.appraisals[0].year ? ` ${d.appraisals[0].year}` : ""}${d.appraisals[0].trim ? ` ${esc(d.appraisals[0].trim)}` : ""}${d.appraisals[0].mileage_km ? ` · ${Math.round(d.appraisals[0].mileage_km / 10000 * 10) / 10} 萬公里` : ""}${d.appraisals[0].book_quanwei || d.appraisals[0].book_tianshu ? ` · 權威 ${wan(d.appraisals[0].book_quanwei)}／天書 ${wan(d.appraisals[0].book_tianshu)}` : ""}${d.appraisals[0].customer_ask ? ` · 客人想要 ${wan(d.appraisals[0].customer_ask)}` : ""}</p>
      <p class="faint" style="margin-top:4px">估車群 ${fmtD(d.appraisals[0].reported_at)} · ${esc(d.appraisals[0].reported_by)}</p></div>` : ""}
    ${(d.reports || []).length ? `<div class="aibox"><h4>送貨囉貼文</h4><ul>${d.reports.map((r) => `<li><a href="/reconcile?status=${r.match_status}" data-link>${fmtD(r.reported_at)} ${esc(r.reported_by)} · ${r.sale_price ? nt(r.sale_price) : "沒售價"} · ${MATCH[r.match_status] || r.match_status}</a>${r.plate ? "" : ' <span class="faint">車號空白</span>'}</li>`).join("")}</ul></div>` : ""}
    ${d.loss ? `<div class="aibox ${d.loss.driver === "process" ? "linked" : ""}"><h4>流失原因 ${d.loss.status === "suspected" ? chip("推定") : ""} ${chipConf(d.loss.confidence)} ${chip(DRIVER[d.loss.driver] || d.loss.driver)}</h4>
      <p><b>${esc(lossLabel(d.loss.primary_reason))}</b>${d.loss.secondary_reason ? ` · 副因 ${esc(lossLabel(d.loss.secondary_reason))}` : ""}${d.loss.alt_reason ? ` · 替代可能 ${esc(lossLabel(d.loss.alt_reason))}` : ""}</p>
      <p class="faint" style="margin-top:4px">${esc(d.loss.summary || "")}</p></div>` : ""}
    <div class="aibox"><h4>建議下一步</h4><ul>${next.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      ${proposed.filter((a) => a.status === "proposed").map((a) => `<div class="row-actions" style="margin-top:6px"><button class="btn sm primary" data-act="${a.id}" data-st="approved">核准</button><button class="btn sm" data-act="${a.id}" data-st="dismissed">駁回</button></div>`).join("")}</div>
    ${(d.labels || []).length ? `<div class="aibox"><h4>人工判讀 <span class="faint">${esc([...new Set(d.labels.map((x) => x.source))].join("、"))}</span></h4><ul>${d.labels.map((x) => `<li>${esc(LABEL_NAME[x.target_key] || x.target_key)}：<b>${esc({ true: "有", false: "沒有", unsure: "不確定" }[x.human_value] || x.human_value)}</b>${x.note ? ` <span class="faint">${esc(x.note)}</span>` : ""}</li>`).join("")}</ul><p class="faint" style="margin-top:4px"><a href="/labels" data-link>看整體準確率</a></p></div>` : ""}
    <div class="aibox"><h4>出現在哪些洞察</h4>${d.insights.length ? `<ul>${d.insights.map((i) => `<li><a href="/insights/${i.id}" data-link>#${i.id} ${esc(i.title)}</a></li>`).join("")}</ul>` : '<p class="faint">沒有。</p>'}</div>
    <div class="aibox"><h4>偵測到的事件</h4><ul>${ev.map((e) => `<li><a href="#e${e.id}"><span class="mono" style="font-size:11px">${fmtD(e.at)}</span> ${EVENT[e.type] || e.type} <span class="faint">${CONF[e.confidence]}</span></a></li>`).join("")}</ul></div>`;
}
