/* 人工判讀 vs 系統：每個標籤對幾筆、錯幾筆；錯的可以點進對話看。 */
import { api } from "../api.js";
import { h, raw, esc, pageHead, chip, pct } from "../ui.js";

export async function render(el, ctx) {
  const source = ctx.query.source || "";
  const d = await api(`/api/labels/summary${source ? `?source=${encodeURIComponent(source)}` : ""}`);
  if (!d.ok) { el.innerHTML = `<div class="empty">${esc(d.message || "讀不到")}</div>`; return; }
  const rows = d.rows || [];
  const bar = (v) => v == null ? '<span class="faint">—</span>' : `<span class="mono">${pct(v)}</span>`;
  const table = rows.length ? `<table class="tbl"><thead><tr><th>標籤</th><th>看了</th><th>對</th><th>錯</th><th>不確定</th><th>準確率</th><th title="系統說有的裡面，人也說有">精確率</th><th title="人說有的裡面，系統也抓到">召回率</th><th>系統多抓</th><th>系統漏抓</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.accuracy != null && r.accuracy < 0.9 ? "warn" : ""}"><td>${esc(r.label)} <span class="faint mono" style="font-size:11px">${esc(r.key)}</span></td><td class="mono">${r.n}</td><td class="mono">${r.agree}</td><td class="mono">${r.disagree}</td><td class="mono">${r.unsure}</td><td>${bar(r.accuracy)}</td><td>${bar(r.precision)}</td><td>${bar(r.recall)}</td><td class="mono">${r.system_yes_human_no || ""}</td><td class="mono">${r.human_yes_system_no || ""}</td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">還沒有人工判讀。用 <code>node scripts/admin/import_golden_labels.mjs</code> 匯入，或在對話頁按 對／錯。</div>`;
  const dis = d.disagreements || [];
  el.innerHTML = `<div class="wrap stack">
    ${pageHead("人工判讀 vs 系統", `${d.leads || 0} 段對話有人工答案${d.sources?.length ? `，來源：${d.sources.map((s) => esc(s)).join("、")}` : ""}。系統的答案每次現算，規則改了這頁就跟著變。目標每個標籤 ≥ 90%。`, "")}
    <div class="row" style="gap:6px;flex-wrap:wrap">${chip("全部", source ? "" : "cyan")}${(d.sources || []).map((s) => `<a href="/labels?source=${encodeURIComponent(s)}" data-link>${chip(esc(s), source === s ? "cyan" : "")}</a>`).join("")}</div>
    <section class="panel">${table}</section>
    <section class="panel"><h3>不一致的（${dis.length}）</h3>
      ${dis.length ? `<table class="tbl"><thead><tr><th>客戶</th><th>標籤</th><th>人說</th><th>系統說</th><th>備註</th></tr></thead><tbody>
        ${dis.map((x) => `<tr><td><a href="/conversations/${x.lead_id}" data-link>${esc(x.pseudonym)}</a></td><td>${esc(x.label)}</td><td class="mono">${esc(x.human)}</td><td class="mono">${esc(x.system || "—")}</td><td class="faint">${esc(x.note || "")}</td></tr>`).join("")}
      </tbody></table>` : '<p class="faint">全部一致。</p>'}
    </section>
  </div>`;
  void h; void raw;
}
