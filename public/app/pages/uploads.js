/* 資料上傳箱：公司把檔案丟進來（LINE 聊天匯出、車源表／會計 CSV、Super 8 匯出、PDF、截圖）。
   認得的當場處理（LINE 匯出 → 群組貼文配對；車源表 CSV → 車輛；會計 CSV → 正式成本；bundle → 匯入），其他先存著、標「待 Curry 處理」。
   上面是收集進度：還缺哪些資料一目了然。刪除只有管理者能按。 */
import { api } from "../api.js";
import { esc, chip, fmtDT, toast, pageHead } from "../ui.js";

const STATUS = { uploaded: "還沒處理", parsed: "已處理", needs_me: "待 Curry 處理", error: "處理失敗" };
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
function resultText(d) {
  const r = d.result || {};
  switch (d.kind) {
    case "line_export": return r.posts == null ? (r.message || "") : `貼文 ${r.posts}：送貨囉 ${r.deal_reports ?? 0}（自動 ${r.auto ?? 0}／待確認 ${r.suggested ?? 0}／無法配對 ${r.unmatched ?? 0}）、到店 ${r.visits ?? 0}、估車 ${r.appraisals ?? 0}、重複略過 ${r.duplicates ?? 0}${r.unparsed ? `、看不懂 ${r.unparsed}` : ""}`;
    case "sheet_csv": return r.inserted == null ? (r.message || "") : `車輛 新增 ${r.inserted}、更新 ${r.updated}${r.no_cost ? `、${r.no_cost} 台沒成本` : ""}${r.no_plate ? `、${r.no_plate} 台沒車牌` : ""}`
      + (r.sheet_deals ? `；成交同步 新增 ${r.sheet_deals.created}／更新 ${r.sheet_deals.updated}${r.sheet_deals.removed ? `／撤銷 ${r.sheet_deals.removed}` : ""}${(r.sheet_deals.unresolved_staff || []).length ? `（業務對不到：${r.sheet_deals.unresolved_staff.join("、")}）` : ""}` : "")
      + ((r.vanished || []).length ? `；${r.vanished.length} 台從車源表消失 → 推定已交車：${r.vanished.map((v) => v.plate || v.name).join("、")}` : "")
      + (r.prev_sheet ? ` · 比對上一份「${r.prev_sheet}」` : " · 第一份車源表，沒有上一份可比");
    case "accounting_csv": return r.matched == null ? (r.message || "") : `正式成本對到 ${r.matched}／${r.total} 筆${r.unmatched_n ? `，${r.unmatched_n} 筆沒對到（${(r.unmatched || []).slice(0, 3).map((u) => `${u.plate} ${u.why}`).join("；")}）` : ""}`;
    case "bundle": return r.counts ? `匯入${r.reset ? "（重灌）" : ""}：${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join("、")}` : (r.message || "");
    default: return r.message || "";
  }
}

export async function render(el, ctx) {
  const r = await api("/api/documents");
  if (!r.ok) { el.innerHTML = `<div class="empty">${esc(r.message || "資料上傳只開放給老闆與主管。")}</div>`; return; }
  const isAdmin = ctx.me?.role === "admin", docs = r.documents || [];
  const done = r.checklist.filter((c) => c.done).length;
  const tiles = r.checklist.map((c) => `<div class="tile ${c.done ? "" : "warn"}"><div class="h"><span class="st">${c.done ? "已有" : "還沒有"}</span>${esc(c.label)}${c.done && c.count ? `<span class="faint" style="margin-left:6px;font-weight:400">${Number(c.count).toLocaleString("zh-TW")} ${esc(c.unit || "")}</span>` : ""}</div><div class="m">${esc(c.hint)}</div></div>`).join("");
  const kindOpts = (sel) => Object.entries(r.kinds).map(([k, l]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
  const rows = docs.map((d) => {
    const canProc = r.processable.includes(d.kind) || ["csv", "text", "json", "other"].includes(d.kind);
    const kindSel = d.status !== "parsed" && canProc ? `<select data-kind="${d.id}" style="padding:3px 6px;font-size:12px"><option value="">維持：${esc(r.kinds[d.kind] || d.kind)}</option>${r.processable.map((k) => `<option value="${k}">改成 ${esc(r.kinds[k])}</option>`).join("")}</select>` : "";
    const btns = [
      canProc && d.status !== "parsed" ? `<button class="btn sm primary" data-proc="${d.id}">${d.kind === "bundle" ? "匯入" : "處理"}</button>` : "",
      d.status === "parsed" && r.processable.includes(d.kind) && d.kind !== "bundle" ? `<button class="btn sm" data-proc="${d.id}">重新處理</button>` : "",
      d.kind === "bundle" && isAdmin ? `<button class="btn sm" data-proc="${d.id}" data-reset="1">重灌匯入</button>` : "",
      `<a class="btn sm" href="/api/documents/${d.id}/file">下載</a>`,
      isAdmin ? `<button class="btn sm" data-del="${d.id}">刪除</button>` : "",
    ].filter(Boolean).join("");
    return `<tr><td><b>${esc(d.name)}</b><div class="faint" style="font-size:12px">${fmtSize(d.size)} · ${esc(d.uploaded_by)} · ${fmtDT(d.uploaded_at)}</div></td>
      <td>${chip(r.kinds[d.kind] || d.kind, r.processable.includes(d.kind) ? "cyan" : "")}${kindSel ? `<div style="margin-top:4px">${kindSel}</div>` : ""}</td>
      <td>${chip(STATUS[d.status] || d.status, d.status === "needs_me" || d.status === "error" ? "amber" : "")}<div class="faint" style="font-size:12px;margin-top:3px;max-width:420px">${esc(resultText(d))}</div></td>
      <td><input data-note="${d.id}" value="${esc(d.note || "")}" placeholder="這是什麼？" style="width:180px;padding:3px 8px;font-size:12px"></td>
      <td><div class="row-actions" style="flex-wrap:wrap;gap:4px">${btns}</div></td></tr>`;
  }).join("");

  el.innerHTML = `<div class="wrap stack">
    ${pageHead("資料上傳", "把公司的檔案丟進來就好：LINE 聊天匯出、車源表或會計表的 CSV、Super 8 匯出、PDF、截圖都可以。認得的會馬上處理，其他的 Curry 來接。", "")}
    <section><div class="ph" style="margin-bottom:6px"><h3 class="muted" style="margin:0;font-weight:500;letter-spacing:.06em">收集進度 ${done}／${r.checklist.length}</h3><span class="faint">四樣就能跑完整條線：Super 8 對話、三個群的匯出、車源表、員工名冊</span></div><div class="tiles">${tiles}</div></section>
    <section class="panel"><h3>上傳 <span class="faint" style="letter-spacing:0;font-weight:400">單檔 25 MB 內 · Excel 請先另存 CSV · 行照、身分證等證件照片不要傳</span></h3>
      <div class="drop" id="drop"><div>把檔案拖到這裡，或 <label class="btn sm" for="fileIn">選檔案</label>（可以一次多個）</div><div class="faint" style="font-size:12px;margin-top:6px">LINE 聊天室 › 設定 › 匯出聊天紀錄的 .txt 直接丟；Google Sheet › 檔案 › 下載 › CSV</div><input type="file" id="fileIn" multiple hidden></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center">
        <select id="kindSel"><option value="auto">自動判斷種類</option>${kindOpts("")}</select>
        <input id="noteIn" placeholder="這是什麼？（例如：成交群 7–8 月、車源表 9/5 版、官方後台匯出）" style="flex:1;min-width:240px">
        <button class="btn primary" id="goUp" disabled>上傳</button></div>
      <div id="picked" class="faint" style="font-size:12.5px;margin-top:6px"></div>
      <div id="upRes" style="margin-top:8px;font-size:12.5px"></div></section>
    <section class="panel"><h3>已上傳 <span class="faint" style="letter-spacing:0;font-weight:400">${docs.length} 個檔案 · 檔案放在系統的儲存空間，正式上線前要搬到公司自己的 Cloudflare 帳號</span></h3>
      ${docs.length ? `<table class="tbl dense"><thead><tr><th>檔案</th><th>種類</th><th>狀態／結果</th><th>備註</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">還沒有檔案。從上面丟進來。</div>'}</section>
  </div>`;

  /* 選檔與拖放 */
  let files = [];
  const drop = el.querySelector("#drop"), input = el.querySelector("#fileIn"), picked = el.querySelector("#picked"), go = el.querySelector("#goUp");
  const setFiles = (list) => { files = [...list]; picked.textContent = files.length ? `已選 ${files.length} 個：${files.map((f) => `${f.name}（${fmtSize(f.size)}）`).join("、")}` : ""; go.disabled = !files.length; };
  input.onchange = () => setFiles(input.files);
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) setFiles(e.dataTransfer.files); });
  go.onclick = async () => {
    if (!files.length) return; go.disabled = true; go.textContent = "上傳中…";
    const fd = new FormData(); for (const f of files) fd.append("file", f, f.name);
    fd.append("note", el.querySelector("#noteIn").value); fd.append("kind", el.querySelector("#kindSel").value);
    let j = {}; try { const resp = await fetch("/api/documents", { method: "POST", body: fd, credentials: "same-origin" }); j = await resp.json(); } catch (e) { j = { ok: false, message: String(e) }; }
    go.textContent = "上傳"; go.disabled = false;
    if (!j.ok) { toast(j.message || "上傳失敗"); return; }
    el.querySelector("#upRes").innerHTML = j.files.map((f) => `<div>${f.ok ? "" : '<span class="warn">✗</span> '}<b>${esc(f.name)}</b> ${f.ok ? (f.duplicate ? `<span class="faint">${esc(f.message)}</span>` : `${chip(f.kind_label || f.kind, "cyan")} ${f.processed ? `<span class="faint">${esc(resultText({ kind: f.kind, result: f.processed.result }))}</span>` : '<span class="faint">已存檔</span>'}`) : `<span class="warn">${esc(f.message)}</span>`}</div>`).join("");
    toast("上傳完成"); setTimeout(() => render(el, ctx), 900);
  };
  /* 處理、備註、刪除 */
  el.querySelectorAll("[data-proc]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.proc; const reset = b.dataset.reset === "1";
    if (reset && !confirm("重灌會清掉現有的對話、客戶、成交資料再匯入，確定？")) return;
    const kindSel = el.querySelector(`[data-kind="${id}"]`); const kind = kindSel && kindSel.value ? kindSel.value : undefined;
    b.disabled = true; b.textContent = "處理中…";
    const x = await api(`/api/documents/${id}/process`, { kind, reset });
    toast(x.ok ? "處理完成" : (x.message || x.result?.message || "失敗")); render(el, ctx);
  });
  el.querySelectorAll("[data-note]").forEach((inp) => inp.addEventListener("change", async () => { const x = await api(`/api/documents/${inp.dataset.note}`, { note: inp.value }, "PATCH"); toast(x.ok ? "備註已存" : "失敗"); }));
  el.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => { if (!confirm("刪掉這個檔案？")) return; const x = await api(`/api/documents/${b.dataset.del}`, null, "DELETE"); toast(x.ok ? "已刪除" : (x.message || "失敗")); render(el, ctx); });
}
