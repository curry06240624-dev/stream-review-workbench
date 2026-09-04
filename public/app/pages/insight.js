/* /insights/:id —— 各模組共用的證據視圖：洞察 → 受影響的 lead → 每位的證據訊息（前後脈絡）→ 開完整對話。 */
import { api } from "../api.js";
import { h, raw, esc, pct, num, chipConf, chipClaim, chipStage, chip, SEV, bubble, toast, fmtDT } from "../ui.js";

export async function render(el, ctx) {
  const id = ctx.params.id;
  const [ev, ins] = await Promise.all([api(`/api/insights/${id}/evidence`), api("/api/insights")]);
  if (!ev.ok) { el.innerHTML = `<div class="empty">${esc(ev.message || "找不到這條洞察。")}</div>`; return; }
  const i = ev.insight;
  const full = (ins.insights || []).find((x) => x.id === i.id);
  const actions = full ? full.actions : [];
  const [factPart, hypoPart] = String(i.summary || "").split(/\n假設：/);
  const m = i.metric || {};
  const metricLine = [m.value != null ? (m.unit === "rate" ? pct(m.value) : m.unit === "min" ? `${m.value} 分鐘` : num(m.value)) : null,
    m.baseline != null ? `前期 ${m.unit === "rate" ? pct(m.baseline) : num(m.baseline)}` : null, m.n != null ? `n=${m.n}` : null].filter(Boolean).join(" · ");

  const STATUS = { approved: "已核准", dismissed: "已駁回", done: "已完成" };
  const ROLE = { ceo: "老闆", manager: "主管", staff: "業務" };
  /* 先組好字串再塞進 h``：三層巢狀樣板字串會讓瀏覽器解析失敗（missing ) after argument list） */
  const actsHtml = actions.length ? `<div class="aibox"><h4>建議動作</h4><ul>${actions.map((a) => {
    const btns = a.status === "proposed"
      ? `<span class="row-actions"><button class="btn sm primary" data-act="${a.id}" data-st="approved">核准</button><button class="btn sm" data-act="${a.id}" data-st="dismissed">駁回</button></span>`
      : `<span class="chip ${a.status === "approved" ? "cyan" : ""}">${STATUS[a.status] || a.status}</span>`;
    return `<li style="display:flex;gap:10px;align-items:center;margin:4px 0"><span>${chip(ROLE[a.owner_role] || a.owner_role)}</span><span style="flex:1">${esc(a.text)}</span>${btns}</li>`;
  }).join("")}</ul></div>` : "";

  el.innerHTML = h`<div class="wrap stack">
    <div class="ph"><div><div class="faint" style="font-size:12px;margin-bottom:4px"><a href="/overview" data-link>CEO 總覽</a> › 證據</div><h1 class="sev-${i.severity}" style="color:var(--text)">${i.title}</h1></div><span class="sp"></span>
      <a class="btn sm" href="/conversations?insight=${i.id}" data-link>受影響客戶清單 ›</a></div>

    <section class="panel">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">${raw(chip(SEV[i.severity] || i.severity, i.severity === "critical" ? "red" : i.severity === "high" ? "amber" : ""))} ${raw(chipClaim(i.claim))} ${raw(chipConf(i.confidence))}<span class="faint">${metricLine}</span><span class="faint">· ${i.period_from?.slice(0, 10)} ～ ${i.period_to?.slice(0, 10)}</span></div>
      <div class="aibox"><h4>${raw(chipClaim("fact"))} 這條洞察在說什麼</h4><p>${factPart}</p></div>
      ${hypoPart ? raw(h`<div class="aibox"><h4>${raw(chipClaim("hypothesis"))} AI 認為可能的原因</h4><p>${hypoPart}</p></div>`) : ""}
      ${raw(actsHtml)}
    </section>

    <div class="ph" style="margin-bottom:6px"><h3 class="muted" style="margin:0;font-weight:500;letter-spacing:.06em">受影響的客戶（${ev.groups.length}）</h3><span class="faint">每位顯示支持這條結論的訊息，前後各兩則脈絡</span></div>
    ${raw(ev.groups.map((g) => {
      const L = g.lead || {};
      const evMsgs = g.messages.filter((x) => x.is_evidence).map((x) => x.id);
      return `<section class="panel" style="padding:12px 16px">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <b>${esc(L.contact)}</b><span class="muted">業務 ${esc(L.staff)}</span><span class="muted">${esc(L.vehicle)}</span>${chipStage(L.stage)}
          ${L.outcome ? chip({ sold: "已成交", lost: "已流失" }[L.outcome] || L.outcome, L.outcome === "sold" ? "cyan" : "") : chip("進行中")}
          <span class="sp"></span><a href="/conversations/${L.id}?from=insight:${i.id}#m${evMsgs[0] || ""}" data-link>開啟完整對話 ›</a></div>
        <div class="thread">${g.messages.map((mm) => bubble(mm, { evidence: mm.is_evidence ? (mm.note || "證據") : null })).join("")}</div>
      </section>`;
    }).join(""))}
  </div>`;

  el.querySelectorAll("[data-act]").forEach((b) => b.onclick = async () => {
    const r = await api(`/api/actions/${b.dataset.act}`, { status: b.dataset.st }, "PATCH");
    toast(r.ok ? (b.dataset.st === "approved" ? "已核准，會出現在需要注意頁" : "已駁回") : "失敗"); render(el, ctx);
  });
}
