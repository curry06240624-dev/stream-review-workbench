/* 待確認配對：成交群「送貨囉」貼文 → 車源表的車 → 客戶 → 業務 → 成交帳本。
   規則產生的配對提案附理由與把握；老闆確認、更改或拒絕；自動配對可撤銷。也可以把 LINE 匯出的群組聊天紀錄貼進來。
   毛利：庫存車＋車源表有成本＝估算；同行車或車號空白＝無成本，不算毛利（正式毛利以會計為準）。 */
import { api } from "../api.js";
import { esc, nt, chip, fmtDT, fmtD, toast, pageHead, chipConf, MATCH, DEPOSIT, LOAN } from "../ui.js";

const TABS = [["suggested", "待確認"], ["unmatched", "無法配對"], ["auto", "自動配對"], ["confirmed", "已確認"], ["rejected", "已拒絕"], ["", "全部"]];

export async function render(el, ctx) {
  const status = ctx.query.status ?? "suggested";
  const [r, st] = await Promise.all([api(`/api/reconcile${status ? `?status=${status}` : ""}`), api("/api/staff-aliases")]);
  if (!r.ok) { el.innerHTML = `<div class="empty">${esc(r.message || "待確認配對只開放給老闆與主管。")}</div>`; return; }
  const c = r.counts, n = (k) => c[k]?.n ?? 0;
  const salesStaff = (st.ok ? st.staff : []).filter((s) => ["sales", "both"].includes(s.job || (s.role === "agent" ? "both" : "")));
  const isAdmin = ctx.me?.role === "admin";

  const tile = (label, v, sub, href, warn) => `<a class="tile ${warn ? "warn" : ""}" href="${href}" data-link><div class="h">${label}</div><div class="t" style="font-size:20px;font-weight:500">${v}</div><div class="m">${sub || ""}</div></a>`;
  const tiles = `<div class="tiles">
    ${tile("待確認", n("suggested"), "有候選，要人選", "/reconcile?status=suggested", n("suggested") > 0)}
    ${tile("無法配對", n("unmatched"), "對不到車也對不到客戶", "/reconcile?status=unmatched", n("unmatched") > 0)}
    ${tile("自動配對", n("auto"), "車牌或客戶名確定，可撤銷", "/reconcile?status=auto", false)}
    ${tile("沒有成本的成交", r.deals_no_cost, `估算毛利 ${r.deals_estimate} 筆 · 正式毛利以會計為準`, "/deals", r.deals_no_cost > 0)}
  </div>`;
  const missing = Object.entries(r.missing).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
  const aiLine = `最近 ${r.recent.days} 天 ${r.recent.n} 則送貨囉、售價合計 ${nt(r.recent.amount)}；${n("suggested") + n("unmatched")} 則還沒對上，沒對上的成交不算進業務成交率與毛利。${missing ? `貼文最常缺：${missing}。` : ""}`;
  const tabs = `<div class="seg" id="rcTabs">${TABS.map(([k, l]) => `<button class="${k === status ? "on" : ""}" data-s="${k}">${l}${k ? ` ${n(k)}` : ""}</button>`).join("")}</div>`;

  const cards = r.rows.map((x) => cardHtml(x, salesStaff)).join("");
  const unmatchedPosts = (r.unmatched_posts || []).map((p) => `<li class="act"><span>${chip({ reception: "接待群", appraisal: "估車群", deal: "成交群" }[p.kind] || p.kind)}</span><span class="txt">${esc(p.text).slice(0, 90)}</span><span class="faint">${esc(p.note)} · ${fmtD(p.at)}</span></li>`).join("");
  const unparsed = (r.unparsed_posts || []).map((p) => `<li class="act"><span class="txt faint">${esc(p.text).slice(0, 90)}</span><span class="faint">${esc(p.note)} · ${fmtD(p.at)}</span></li>`).join("");

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("待確認配對", aiLine, `<button class="btn sm" id="rematchAll">重新配對全部</button>`)}
    ${tiles}
    <section class="panel"><h3>送貨囉貼文 <span class="faint" style="letter-spacing:0;font-weight:400">車牌相同＝確定 · 年份車型顏色只對到一台＝強烈建議 · 多台＝可能；客戶名＝確定 · 同一台車近期唯一在談的客戶＝強烈建議</span><span class="sp"></span>${tabs}</h3>
      ${r.rows.length ? `<div class="stack">${cards}</div>` : '<div class="empty">這個狀態沒有貼文。</div>'}</section>
    <section class="grid g2">
      <div class="panel"><h3>匯入群組聊天紀錄 <span class="faint" style="letter-spacing:0;font-weight:400">LINE 聊天室 › 設定 › 匯出聊天紀錄（.txt）整份貼上；同一則不會重複匯入</span></h3>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap"><select id="pkind"><option value="auto">自動判斷（成交／接待／估車）</option><option value="deal">成交群（送貨囉）</option><option value="reception">接待群</option><option value="appraisal">估車群</option></select><span class="faint" style="font-size:12px">證件照片不會入庫；客戶名只用來對客戶。</span></div>
        <textarea class="paste" id="ptext" placeholder="2026.09.04 星期五&#10;17:48&#9;火箭&#9;送貨囉❤️🔥&#10;年份：2016&#10;車型：c300&#10;…"></textarea>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px"><button class="btn primary" id="pgo">匯入</button><span class="faint" id="pmsg"></span></div>
        <div id="pres" style="margin-top:8px;font-size:12.5px"></div></div>
      <div class="panel"><h3>其他群組沒對上的貼文 <span class="faint" style="letter-spacing:0;font-weight:400">接待群／估車群找不到客戶名，或看不出是哪一種貼文</span></h3>
        ${unmatchedPosts ? `<ul class="acts">${unmatchedPosts}</ul>` : '<div class="empty">沒有。</div>'}
        ${unparsed ? `<h4 class="sub" style="margin-top:10px">看不懂的貼文</h4><ul class="acts">${unparsed}</ul>` : ""}</div>
    </section>
  </div>`;

  el.querySelectorAll("#rcTabs button").forEach((b) => b.onclick = () => ctx.nav(`/reconcile?status=${b.dataset.s}`));
  el.querySelector("#rematchAll").onclick = async (e) => { e.target.disabled = true; const x = await api("/api/reconcile/rematch-all", {}); toast(x.ok ? `重新配對 ${x.rematched} 則` : (x.message || "失敗")); render(el, ctx); };
  el.querySelectorAll("[data-rc]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.rc, act = b.dataset.act; const card = b.closest(".rc");
    const body = {};
    if (act === "confirm") {
      const v = card.querySelector("[data-veh]")?.value, l = card.querySelector("[data-lead]")?.value, s = card.querySelector("[data-staff]")?.value;
      if (v !== undefined) body.vehicle_id = v || null; if (l !== undefined) body.lead_id = l || null; if (s !== undefined) body.staff_id = s || null;
      if (!body.lead_id) { toast("要先選客戶才能建立成交"); return; }
    }
    b.disabled = true;
    const x = await api(`/api/reconcile/${id}/${act}`, body);
    toast(x.ok ? { confirm: "已確認，成交已建立", reject: "已拒絕", undo: "已撤銷，回到待確認", rematch: "已重新配對" }[act] : (x.message || "失敗"));
    render(el, ctx);
  });
  el.querySelectorAll("[data-leadq]").forEach((inp) => inp.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return; e.preventDefault();
    const q = inp.value.trim(); if (!q) return;
    const s = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const sel = inp.closest(".rc").querySelector("[data-lead]");
    const hits = (s.results || []).filter((x) => x.type === "customer");
    if (!hits.length) { toast("找不到這個客戶"); return; }
    for (const h of hits) { const id = h.href.split("/").pop(); if (![...sel.options].some((o) => o.value === id)) sel.add(new Option(`${h.label}${h.sub ? ` · ${h.sub}` : ""} · 搜尋`, id)); }
    sel.value = hits[0].href.split("/").pop();
  }));
  const pgo = el.querySelector("#pgo");
  if (pgo) pgo.onclick = async () => {
    const text = el.querySelector("#ptext").value; if (!text.trim()) { toast("先貼上聊天紀錄"); return; }
    pgo.disabled = true; el.querySelector("#pmsg").textContent = "解析與配對中…";
    const x = await api("/api/admin/import-group", { kind: el.querySelector("#pkind").value, text });
    pgo.disabled = false; el.querySelector("#pmsg").textContent = "";
    if (!x.ok) { toast(x.message || "失敗"); return; }
    el.querySelector("#pres").innerHTML = `<div>貼文 ${x.posts} 則：送貨囉 ${x.deal_reports}（自動 ${x.auto}／待確認 ${x.suggested}／無法配對 ${x.unmatched}）、到店 ${x.visits}、估車 ${x.appraisals}、重複略過 ${x.duplicates}、看不懂 ${x.unparsed.length}</div>
      ${x.warnings?.length ? `<div class="warn" style="margin-top:4px">${x.warnings.map(esc).join("；")}</div>` : ""}
      ${x.unparsed.length ? `<div class="faint" style="margin-top:4px">看不懂的例子：${esc(x.unparsed[0].text).slice(0, 80)}</div>` : ""}`;
    toast("匯入完成"); setTimeout(() => render(el, ctx), 800);
  };
}

function cardHtml(x, salesStaff) {
  const stChip = chip(MATCH[x.match_status] || x.match_status, x.match_status === "auto" ? "cyan" : x.match_status === "suggested" || x.match_status === "unmatched" ? "amber" : "");
  const fields = [
    ["年份", x.year ?? "—"], ["車型", esc(x.model_text) || "—"], ["顏色", esc(x.color) || "—"], ["車號", x.plate ? esc(x.plate) : '<span class="warn">空白</span>'],
    ["售價", x.sale_price != null ? nt(x.sale_price) : '<span class="warn">沒有</span>'], ["訂金", DEPOSIT[x.deposit] ?? esc(x.deposit)],
    ["同行/庫存", x.source_kind === "peer" ? `同行 · ${esc(x.peer_dealer)}` : x.source_kind === "stock" ? "庫存" : "—"],
    ["送貨單位", x.delivery_by ? `${esc(x.delivery_by)}${x.delivery_uncertain ? ` ${chip("寫法不確定", "amber")}` : ""}` : "—"],
    ["貸款", LOAN[x.loan_status] ?? "—"], ["備註", esc(x.note) || "—"],
    ["發文人", `${esc(x.reported_by)}${x.reported_by_name ? ` <span class="faint">→ ${esc(x.reported_by_name)}</span>` : ` ${chip("對不到員工", "amber")}`}`],
  ];
  const missing = (x.missing || []).map((m) => chip(`缺${m}`, "amber")).join(" ");
  const vc = x.candidates?.vehicles || [], lc = x.candidates?.leads || [];
  const editable = x.match_status === "suggested" || x.match_status === "unmatched";
  const opt = (list, selected, none) => `<option value="">${none}</option>` + list.map((o) => `<option value="${o.id}" ${Number(selected) === o.id ? "selected" : ""}>${esc(o.label)} · ${esc(o.reason)}</option>`).join("");
  const vehicleRow = editable
    ? `<select data-veh>${opt(vc, x.vehicle_id, vc.length ? "不指定車" : "沒有候選車")}</select>`
    : `${x.vehicle_label ? `${esc(x.vehicle_year || "")} ${esc(x.vehicle_label)}${x.vehicle_color ? ` · ${esc(x.vehicle_color)}` : ""}${x.vehicle_plate ? ` · ${esc(x.vehicle_plate)}` : ""}` : '<span class="faint">沒有對到車</span>'}`;
  const leadRow = editable
    ? `<select data-lead>${opt(lc, x.lead_id, lc.length ? "不指定客戶" : "沒有候選客戶")}</select><input data-leadq placeholder="或輸入客戶名搜尋，Enter" style="margin-top:4px">`
    : `${x.contact ? `<a href="/conversations/${x.lead_id}" data-link>${esc(x.contact)}</a> <span class="faint">${esc(x.contact_display || "")}</span>` : '<span class="faint">沒有對到客戶</span>'}`;
  const staffRow = editable
    ? `<select data-staff><option value="">不指定</option>${salesStaff.map((s) => `<option value="${s.id}" ${Number(x.staff_id) === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`
    : (x.staff_name ? esc(x.staff_name) : '<span class="faint">未指派</span>');
  const conf = x.match_confidence ? chipConf(x.match_confidence) : "";
  const gpTxt = x.deal_id ? (x.deal_cost_source === "none" ? '<span class="faint">無成本，毛利不算</span>' : `毛利 ${nt(x.deal_gp)} ${chip("估算", "est")}`) : "";
  const btns = {
    suggested: `<button class="btn sm primary" data-rc="${x.id}" data-act="confirm">確認配對</button><button class="btn sm" data-rc="${x.id}" data-act="rematch">重新配對</button><button class="btn sm" data-rc="${x.id}" data-act="reject">拒絕</button>`,
    unmatched: `<button class="btn sm primary" data-rc="${x.id}" data-act="confirm">確認配對</button><button class="btn sm" data-rc="${x.id}" data-act="rematch">重新配對</button><button class="btn sm" data-rc="${x.id}" data-act="reject">拒絕</button>`,
    auto: `<button class="btn sm primary" data-rc="${x.id}" data-act="confirm">確認</button><button class="btn sm" data-rc="${x.id}" data-act="undo">撤銷</button>`,
    confirmed: `<button class="btn sm" data-rc="${x.id}" data-act="undo">取消確認</button>`,
    rejected: `<button class="btn sm" data-rc="${x.id}" data-act="rematch">重新配對</button>`,
  }[x.match_status] || "";
  return `<div class="rc ${x.match_status}">
    <div class="hd">${stChip}${conf}<b>${fmtDT(x.reported_at)}</b><span class="faint">${esc(x.reported_by)}</span>${missing}${gpTxt ? `<span class="sp"></span><span class="faint">${gpTxt}</span>` : ""}</div>
    <div><div class="kv">${fields.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("")}</div><details style="margin-top:6px"><summary class="faint" style="font-size:12px;cursor:pointer">原文</summary><div class="raw">${esc(x.raw_text)}</div></details></div>
    <div class="prop">
      <div class="row"><span>車輛</span><div>${vehicleRow}</div></div>
      <div class="row"><span>客戶</span><div>${leadRow}</div></div>
      <div class="row"><span>業務</span><div>${staffRow}</div></div>
      <ul class="why">${(x.match_reasons || []).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <div class="btns">${btns}${x.lead_id && !editable ? `<a class="btn sm" href="/conversations/${x.lead_id}" data-link>看對話 ›</a>` : ""}</div>
    </div></div>`;
}
