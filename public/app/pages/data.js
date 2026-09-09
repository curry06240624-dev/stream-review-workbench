/* 資料與設定：這個展示用的是什麼資料、怎麼去識別化、要重算什麼按哪裡；員工的工作性質（訊息組／業務）與各系統暱稱在這裡維護。 */
import { api } from "../api.js";
import { esc, num, chip, toast, pageHead, JOB } from "../ui.js";

export async function render(el, ctx) {
  const isAdmin = ctx.me?.role === "admin";
  const [a, ins, br, st, rc] = await Promise.all([api("/api/analytics?days=365"), api("/api/insights"), api("/api/brief"), api("/api/staff-aliases"), api("/api/reconcile?status=suggested")]);
  const ev = a.ok ? Object.values(a.funnel.events).reduce((s, n) => s + n, 0) : 0;
  const staff = st.ok ? st.staff : [];
  const pending = rc.ok ? (rc.counts.suggested?.n ?? 0) + (rc.counts.unmatched?.n ?? 0) : null;
  const staffRows = staff.map((u) => `<tr data-uid="${u.id}"><td><b>${esc(u.name)}</b> <span class="faint">${esc(u.team)}</span></td><td class="muted">${{ admin: "管理者", operator: "運營", agent: "員工" }[u.role] || u.role}</td>
      <td>${isAdmin ? `<select data-job><option value="">依角色</option>${["chat", "sales", "both", "manager"].map((j) => `<option value="${j}" ${u.job === j ? "selected" : ""}>${JOB[j]}${j === "both" ? "（線上也回）" : ""}</option>`).join("")}</select>` : (JOB[u.job] || "依角色")}</td>
      <td>${isAdmin ? `<label style="font-size:12px"><input type="checkbox" data-shared ${u.seat_shared ? "checked" : ""}> 共用</label>` : (u.seat_shared ? "共用" : "—")}</td>
      <td>${(u.aliases || []).map((al) => `<span class="chip">${esc(al.alias)}${isAdmin ? ` <a href="#" data-del="${al.id}" title="刪除" style="color:var(--faint)">×</a>` : ""}</span>`).join(" ")}
          ${isAdmin ? `<input data-alias placeholder="加暱稱，Enter" style="width:120px;padding:3px 8px;font-size:12px;margin-left:6px">` : ""}
          ${isAdmin && u.role !== "admin" ? `<select data-merge title="這個帳號其實是另一個人：把對話、成交、暱稱全部併過去（不能復原）" style="font-size:12px;margin-left:6px"><option value="">同一人，併入…</option>${staff.filter((o) => o.id !== u.id && o.role !== "admin").map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select>` : ""}</td></tr>`).join("");

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("資料與設定", "目前跑的是模擬資料。真實對話進來時走同一條管線：先去識別化，再入庫、再分析；群組貼文在「待確認配對」貼上。", "")}
    <section class="grid g2">
      <div class="panel"><h3>資料來源</h3>
        <div class="kv">
          <div>模式</div><div>${chip("展示模式 · 模擬資料", "cyan")}</div>
          <div>最近一年進線</div><div>${a.ok ? num(a.funnel.leads) : "—"} 位${a.ok && a.funnel.menu_only_leads ? ` <span class="faint">另 ${num(a.funnel.menu_only_leads)} 位只加好友／點選單</span>` : ""}</div>
          <div>漏斗事件</div><div>${num(ev)} 筆（不含「不確定」）</div>
          <div>成交</div><div>${a.ok ? num(a.deals.sold) : "—"} 台 · 流失 ${a.ok ? num(a.deals.lost) : "—"} 台${a.ok && a.deals.gp_unknown ? ` · <span class="warn">${a.deals.gp_unknown} 台沒有成本</span>` : ""}</div>
          <div>送貨囉貼文</div><div>${pending == null ? "—" : `${pending} 則待處理`} · <a href="/reconcile" data-link>待確認配對 ›</a></div>
          <div>成立的洞察</div><div>${num((ins.insights || []).length)} 條</div>
          <div>最新簡報</div><div>${br.brief ? `${esc(br.brief.brief_date)} · ${br.brief.model === "template" ? "規則版" : esc(br.brief.model || "AI")}` : "還沒有"}</div>
          <div>登入身分</div><div>${esc(ctx.me?.name || "")} · ${esc({ admin: "老闆", operator: "主管", agent: "業務" }[ctx.me?.role] || ctx.me?.role || "")}</div>
        </div>
      </div>
      <div class="panel"><h3>去識別化與界線</h3>
        <ul class="muted" style="margin:0;padding-left:18px;font-size:13px;line-height:1.8">
          <li>客戶一律用化名顯示；電話、車牌、地址在匯入時就抹掉，資料庫裡沒有原文。行照、身分證等證件照片永遠不入庫。</li>
          <li>每一條洞察、每一個事件都連回原始訊息；沒有證據的結論不會出現在畫面上。</li>
          <li>訊息涵蓋不完整的對話（電話、LINE 官方後台打的字不在紀錄裡）不拿來判「回覆太慢」「跟進不足」。</li>
          <li>毛利＝售價－車源表成本（估算）；同行車或車號空白沒有成本就不算。正式毛利以會計為準。</li>
          <li>AI 只能引用分析層算好的數字；出現事實包沒有的數字，整句退回規則版。這一版只建議、不代發訊息。</li>
        </ul>
      </div>
    </section>
    <section class="panel"><h3>員工工作性質與暱稱 <span class="faint" style="letter-spacing:0;font-weight:400">訊息組＝線上回訊息（回覆、報價、跟進算他）；業務＝到店接待（到店→成交、毛利算他）；暱稱＝LINE 群、Super 8、車源表裡的寫法，貼文才對得到人</span></h3>
      <table class="tbl dense"><thead><tr><th>員工</th><th>帳號角色</th><th>工作性質</th><th>Super 8 座位</th><th>暱稱</th></tr></thead><tbody>${staffRows || '<tr><td colspan="5" class="empty">沒有員工。</td></tr>'}</tbody></table></section>
    ${isAdmin ? `<section class="panel"><h3>重算</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn" id="btnFunnel">重跑漏斗事件</button>
        <button class="btn" id="btnAnalyze">重跑歸因／行為／流失原因</button>
        <button class="btn primary" id="btnInsights">重新分析（洞察＋AI 簡報，約 20 秒）</button>
        <span class="faint" id="dataMsg"></span>
      </div>
      <p class="faint" style="margin:10px 0 0;font-size:12px">匯入新的資料包走命令列：<code class="mono">node scripts/import_bundle.mjs data/mock/bundle.json http://localhost:8788 --reset</code>；群組聊天紀錄在「待確認配對」頁貼上。</p>
    </section>` : ""}
  </div>`;
  const msg = el.querySelector("#dataMsg");
  const bf = el.querySelector("#btnFunnel");
  if (bf) bf.onclick = async () => { bf.disabled = true; msg.textContent = "漏斗計算中…"; const r = await api("/api/admin/funnel/run", {}); msg.textContent = r.ok ? "漏斗事件已重算" : (r.message || "失敗"); bf.disabled = false; };
  const ba = el.querySelector("#btnAnalyze");
  if (ba) ba.onclick = async () => { ba.disabled = true; msg.textContent = "分析中…"; const r = await api("/api/admin/analyze", {}); msg.textContent = r.ok ? `完成：角色 ${r.roles.roles}、流失分析 ${r.loss.analyzed}` : (r.message || "失敗"); ba.disabled = false; };
  const bi = el.querySelector("#btnInsights");
  if (bi) bi.onclick = async () => { bi.disabled = true; msg.textContent = "分析中…"; const r = await api("/api/insights/run", { days: 7 }); msg.textContent = r.ok ? `完成：${r.persisted} 條洞察、簡報 ${r.brief?.mode === "ai" ? "AI" : "規則版"}` : (r.message || "失敗"); bi.disabled = false; toast(r.ok ? "分析完成" : "失敗"); render(el, ctx); };
  /* 工作性質／座位／暱稱：只有管理者 */
  el.querySelectorAll("[data-job]").forEach((sel) => sel.onchange = async () => { const r = await api(`/api/members/${sel.closest("tr").dataset.uid}`, { job: sel.value }, "PATCH"); toast(r.ok ? "已更新工作性質" : (r.message || "失敗")); });
  el.querySelectorAll("[data-shared]").forEach((cb) => cb.onchange = async () => { const r = await api(`/api/members/${cb.closest("tr").dataset.uid}`, { seat_shared: cb.checked }, "PATCH"); toast(r.ok ? "已更新" : (r.message || "失敗")); });
  el.querySelectorAll("[data-alias]").forEach((inp) => inp.addEventListener("keydown", async (e) => { if (e.key !== "Enter") return; e.preventDefault(); const alias = inp.value.trim(); if (!alias) return; const r = await api("/api/staff-aliases", { user_id: Number(inp.closest("tr").dataset.uid), alias, system: "line" }); toast(r.ok ? "已加暱稱" : (r.message || "失敗")); if (r.ok) render(el, ctx); }));
  el.querySelectorAll("[data-del]").forEach((a) => a.onclick = async (e) => { e.preventDefault(); const r = await api(`/api/staff-aliases/${a.dataset.del}`, null, "DELETE"); toast(r.ok ? "已刪除" : (r.message || "失敗")); if (r.ok) render(el, ctx); });
  /* 併帳號：同一個人在後台與群組用不同名字（Ash＝賴安）→ 把這列併進選的那個人；不可逆，所以先確認 */
  el.querySelectorAll("[data-merge]").forEach((sel) => sel.onchange = async () => {
    const into = Number(sel.value); if (!into) return;
    const tr = sel.closest("tr"); const from = tr.querySelector("b")?.textContent || ""; const target = sel.options[sel.selectedIndex].textContent;
    if (!confirm(`把「${from}」併入「${target}」？\n所有對話、成交、暱稱都會改成 ${target}，「${from}」會變成 ${target} 的暱稱。這個動作不能復原。`)) { sel.value = ""; return; }
    const r = await api(`/api/members/${tr.dataset.uid}/merge`, { into });
    toast(r.ok ? `已把 ${from} 併入 ${target}` : (r.message || "失敗")); if (r.ok) render(el, ctx); else sel.value = "";
  });
}
