/* 資料與設定：這個展示用的是什麼資料、怎麼去識別化、要重算什麼按哪裡。 */
import { api } from "../api.js";
import { esc, num, chip, toast, pageHead } from "../ui.js";

export async function render(el, ctx) {
  const isAdmin = ctx.me?.role === "admin";
  const [a, ins, br] = await Promise.all([api("/api/analytics?days=365"), api("/api/insights"), api("/api/brief")]);
  const ev = a.ok ? Object.values(a.funnel.events).reduce((s, n) => s + n, 0) : 0;
  el.innerHTML = `<div class="wrap stack">
    ${pageHead("資料與設定", "目前跑的是模擬資料。真實對話進來時走同一條管線：先去識別化，再入庫、再分析。", "")}
    <section class="grid g2">
      <div class="panel"><h3>資料來源</h3>
        <div class="kv">
          <div>模式</div><div>${chip("展示模式 · 模擬資料", "cyan")}</div>
          <div>最近一年進線</div><div>${a.ok ? num(a.funnel.leads) : "—"} 位</div>
          <div>漏斗事件</div><div>${num(ev)} 筆（不含「不確定」）</div>
          <div>成交</div><div>${a.ok ? num(a.deals.sold) : "—"} 台 · 流失 ${a.ok ? num(a.deals.lost) : "—"} 台</div>
          <div>成立的洞察</div><div>${num((ins.insights || []).length)} 條</div>
          <div>最新簡報</div><div>${br.brief ? `${esc(br.brief.brief_date)} · ${br.brief.model === "template" ? "規則版" : esc(br.brief.model || "AI")}` : "還沒有"}</div>
          <div>登入身分</div><div>${esc(ctx.me?.name || "")} · ${esc({ admin: "老闆", operator: "主管", agent: "業務" }[ctx.me?.role] || ctx.me?.role || "")}</div>
        </div>
      </div>
      <div class="panel"><h3>去識別化與界線</h3>
        <ul class="muted" style="margin:0;padding-left:18px;font-size:13px;line-height:1.8">
          <li>客戶一律用化名顯示；電話、車牌、地址在匯入時就抹掉，資料庫裡沒有原文。</li>
          <li>每一條洞察、每一個事件都連回原始訊息；沒有證據的結論不會出現在畫面上。</li>
          <li>AI 只能引用分析層算好的數字；出現事實包沒有的數字，整句退回規則版。</li>
          <li>這一版只建議、不代發訊息；動作核准後由人執行。</li>
          <li>Super 8／LINE 的正式接法（匯出格式、webhook）等真實資料切片確認後再定。</li>
        </ul>
      </div>
    </section>
    ${isAdmin ? `<section class="panel"><h3>重算</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn" id="btnFunnel">重跑漏斗事件</button>
        <button class="btn primary" id="btnInsights">重新分析（洞察＋AI 簡報，約 20 秒）</button>
        <span class="faint" id="dataMsg"></span>
      </div>
      <p class="faint" style="margin:10px 0 0;font-size:12px">匯入新的資料包走命令列：<code class="mono">node scripts/import_bundle.mjs data/mock/bundle.json http://localhost:8788 --reset</code></p>
    </section>` : ""}
  </div>`;
  const msg = el.querySelector("#dataMsg");
  const bf = el.querySelector("#btnFunnel");
  if (bf) bf.onclick = async () => { bf.disabled = true; msg.textContent = "漏斗計算中…"; const r = await api("/api/admin/funnel/run", {}); msg.textContent = r.ok ? "漏斗事件已重算" : (r.message || "失敗"); bf.disabled = false; };
  const bi = el.querySelector("#btnInsights");
  if (bi) bi.onclick = async () => { bi.disabled = true; msg.textContent = "分析中…"; const r = await api("/api/insights/run", { days: 7 }); msg.textContent = r.ok ? `完成：${r.persisted} 條洞察、簡報 ${r.brief?.mode === "ai" ? "AI" : "規則版"}` : (r.message || "失敗"); bi.disabled = false; toast(r.ok ? "分析完成" : "失敗"); render(el, ctx); };
}
