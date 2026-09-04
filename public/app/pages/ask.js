/* 問 AI：一個輸入框、固定結構的答案（結論 → 關鍵數據 → 原因／假設 → 受影響客戶 → 證據 → 建議行動 → 我怎麼算的）。
   數字全部來自分析層，每個都能點回去；AI 只講人話與提假設。 */
import { api } from "../api.js";
import { esc, chip, drawChart } from "../ui.js";

const EXAMPLES = ["為什麼這週報價後客戶都不回？", "哪個業務報價後流失最多？", "今天我該先處理誰？", "預約到店的狀況怎麼樣？", "這個月成交和毛利如何？", "哪台車詢問最多但最少成交？"];
const ROLE = { ceo: "老闆", manager: "主管", staff: "業務" };

export async function render(el, ctx) {
  el.innerHTML = `<div class="wrap ask">
    <div class="ph"><h1>問 AI</h1><div class="ai">像跟幕僚講話就好。每個數字都能點進去看客戶與證據；AI 只負責講人話，不算數。</div></div>
    <input class="big" id="askIn" placeholder="例如：為什麼這週報價後客戶都不回？" autocomplete="off">
    <div class="ex" id="askEx">${EXAMPLES.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <div id="askOut"></div>
  </div>`;
  const input = el.querySelector("#askIn"), out = el.querySelector("#askOut");
  const run = async (q) => {
    q = String(q || "").trim(); if (!q) return;
    input.value = q;
    out.innerHTML = `<div class="loading">正在讀最近的對話與帳本…</div>`;
    const r = await api("/api/ask", { q });
    if (!r.ok) { out.innerHTML = `<div class="empty">${esc(r.message || "回答失敗")}</div>`; return; }
    out.innerHTML = answerHtml(r.answer);
    drawChart(out.querySelector("#askChart"), r.answer.chart);
    out.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => run(b.dataset.q));
    history.replaceState(null, "", `/ask?q=${encodeURIComponent(q)}`);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(input.value); });
  el.querySelectorAll("#askEx [data-q]").forEach((b) => b.onclick = () => run(b.dataset.q));
  if (ctx.query.q) run(ctx.query.q); else input.focus();
}

function answerHtml(a) {
  const lbl = (c) => `<span class="lbl ${c === "hypothesis" ? "h" : ""}">${c === "hypothesis" ? "假設" : "事實"}</span>`;
  return `<div class="ans">
    <section><h4>結論 <span class="faint" style="letter-spacing:0;font-weight:400">· ${a.mode === "ai" ? "AI 敘述，數字經事實包核對" : "規則版"} · 最近 ${a.period.days} 天</span></h4><p>${esc(a.conclusion)}</p></section>
    <section><h4>關鍵數據</h4><div class="chips">${a.numbers.map((n) => `<a ${n.href ? `href="${esc(n.href)}" data-link` : ""}>${esc(n.label)} <b>${esc(n.value)}</b>${n.sub ? ` <span class="faint">${esc(n.sub)}</span>` : ""}</a>`).join("")}</div></section>
    ${a.chart ? `<section><div style="height:180px"><canvas id="askChart"></canvas></div></section>` : ""}
    ${a.reasons.length ? `<section><h4>原因／假設</h4>${a.reasons.map((r) => `<p>${lbl(r.claim)}${esc(r.text)}</p>`).join("")}</section>` : ""}
    ${a.leads.length ? `<section><h4>受影響客戶 <span class="faint" style="letter-spacing:0;font-weight:400">· ${a.leads.length} 位</span></h4><ul class="acts">${a.leads.map((l) => `<li class="act"><a href="/conversations/${l.id}" data-link><b>${esc(l.contact)}</b></a><span class="muted">${esc(l.staff)}</span><span class="muted">${esc(l.vehicle)}</span><span class="faint txt">${esc(l.note)}</span></li>`).join("")}</ul></section>` : ""}
    ${a.evidence.length ? `<section><h4>證據</h4><div class="chips">${a.evidence.map((e) => `<a href="/insights/${e.id}" data-link>#${e.id} ${esc(e.title)}</a>`).join("")}</div></section>` : ""}
    ${a.actions.length ? `<section><h4>建議行動</h4><ul style="margin:0;padding-left:0;list-style:none">${a.actions.map((x) => `<li style="margin:4px 0">${chip(ROLE[x.owner_role] || x.owner_role)} ${esc(x.text)}</li>`).join("")}</ul></section>` : ""}
    <section><details><summary>我怎麼算的</summary><ul class="muted" style="font-size:13px;margin:8px 0 0;padding-left:18px;line-height:1.7">${a.how.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></details></section>
    ${a.suggest?.length ? `<div class="ex" style="margin:14px 0 0">${a.suggest.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>` : ""}
  </div>`;
}
