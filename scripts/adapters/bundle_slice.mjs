/**
 * 把分批 bundle（part-001.json …）切成「只留某一段期間」的版本 —— 做跟 Super 8 月匯出等價的測試站用（2026-09-18 Curry：只留 8 月，
 * 讓系統看到的內容跟 Frank／黎手上的 Super 8 8 月匯出一模一樣，人工判讀才是同一份內容在比）。
 *
 *   node scripts/adapters/bundle_slice.mjs <in_dir> <out_dir> --from=2026-08-01 --to=2026-09-01 [--tz=+08:00] [--per=500]
 *
 * 規則（台灣時間 from 00:00 ≤ t < to 00:00）：
 *   - 訊息只留期間內的；對話至少一則期間內訊息才留；涵蓋程度照舊
 *   - lead 跟著對話留；opened_at＝期間內第一則客戶訊息（含選單；沒有客戶訊息就第一則訊息）；first_real_at 不給，匯入器從訊息算
 *     closed_at 不在期間內 → null、outcome 清空（期間內看不到結案就不能算結案）
 *   - 客戶只留被參照到的；first_contact_at 照舊（只是說明欄，不進任何數字）
 *   - staff／teams／vehicles 每批都帶（跟原始分批一樣，匯入以 email／key 去重）
 *   - appointments／visits／deals／deal_reports／appraisals／assignments 依各自時間欄過濾
 * 只印統計，不印任何對話內容。對話數拿去跟 Super 8 匯出的份數對（8 月匯出＝25,321 份）。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const [inDir, outDir] = args.filter((a) => !a.startsWith("--"));
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).slice(k.length + 3);
if (!inDir || !outDir) { console.error("用法：node scripts/adapters/bundle_slice.mjs <in_dir> <out_dir> --from=YYYY-MM-DD --to=YYYY-MM-DD"); process.exit(2); }
const TZ = opt("tz", "+08:00"), PER = Number(opt("per", "500"));
const fromMs = Date.parse(`${opt("from", "")}T00:00:00${TZ}`), toMs = Date.parse(`${opt("to", "")}T00:00:00${TZ}`);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) { console.error("--from／--to 要是 YYYY-MM-DD，且 to 晚於 from"); process.exit(2); }
const inRange = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) && t >= fromMs && t < toMs; };
mkdirSync(outDir, { recursive: true });

const parts = readdirSync(inDir).filter((f) => /^part-\d+\.json$/.test(f)).sort();
if (!parts.length) { console.error(`${inDir} 沒有 part-*.json`); process.exit(2); }
console.log(`${parts.length} 批 → 只留 ${new Date(fromMs).toISOString()} ～ ${new Date(toMs).toISOString()}`);

let head = null;                      // source_system／generated_at／teams
const staffByEmail = new Map(), vehByKey = new Map();
const st = { conv_in: 0, conv_out: 0, msg_in: 0, msg_out: 0, lead_out: 0, cust_out: 0, closed_cleared: 0, roles: {}, types: {}, deals: 0, appts: 0, visits: 0, reports: 0, appraisals: 0, assignments: 0 };
let buf = { conversations: [], leads: [], customers: [], appointments: [], visits: [], deals: [], deal_reports: [], appraisals: [], assignments: [] }, outN = 0, written = 0;

function flush(force = false) {
  while (buf.conversations.length >= PER || (force && buf.conversations.length)) {
    const convs = buf.conversations.splice(0, PER);
    const leadKeys = new Set(convs.map((c) => c.lead_key).filter(Boolean));
    const leads = []; for (const k of leadKeys) { const l = buf.leads.find((x) => x.key === k); if (l) leads.push(l); }
    buf.leads = buf.leads.filter((l) => !leadKeys.has(l.key));
    const custKeys = new Set([...convs.map((c) => c.customer_key), ...leads.map((l) => l.customer_key)]);
    const customers = buf.customers.filter((c) => custKeys.has(c.key)); buf.customers = buf.customers.filter((c) => !custKeys.has(c.key));
    const pick = (arr, keyOf) => { const out = arr.filter((x) => leadKeys.has(keyOf(x))); return out; };
    const appointments = pick(buf.appointments, (x) => x.lead_key), visits = pick(buf.visits, (x) => x.lead_key), deals = pick(buf.deals, (x) => x.lead_key);
    for (const k of ["appointments", "visits", "deals"]) buf[k] = buf[k].filter((x) => !leadKeys.has(x.lead_key));
    const convKeys = new Set(convs.map((c) => c.key));
    const assignments = buf.assignments.filter((a) => convKeys.has(a.conversation_key)); buf.assignments = buf.assignments.filter((a) => !convKeys.has(a.conversation_key));
    const out = { ...head, generated_at: new Date().toISOString(), staff: [...staffByEmail.values()], vehicles: outN === 0 ? [...vehByKey.values()] : [], customers, leads, conversations: convs, appointments, visits, deals };   // 車輛只放第一批（匯入以 external_id 去重，但不用每批重送）
    if (outN === 0) { out.deal_reports = buf.deal_reports; out.appraisals = buf.appraisals; buf.deal_reports = []; buf.appraisals = []; }   // 貼文不掛 lead：全放第一批
    if (assignments.length) out.assignments = assignments;
    outN++; const name = `part-${String(outN).padStart(3, "0")}.json`;
    writeFileSync(join(outDir, name), JSON.stringify(out)); written += convs.length;
    st.lead_out += leads.length; st.cust_out += customers.length; st.deals += deals.length; st.appts += appointments.length; st.visits += visits.length; st.assignments += assignments.length;
  }
}

for (const f of parts) {
  const b = JSON.parse(readFileSync(join(inDir, f), "utf8"));
  if (!head) head = { source_system: b.source_system, generated_at: b.generated_at, teams: b.teams || [] };
  for (const s of b.staff || []) if (!staffByEmail.has(s.email)) staffByEmail.set(s.email, s);
  for (const v of b.vehicles || []) if (!vehByKey.has(v.key)) vehByKey.set(v.key, v);
  const leadByKey = new Map((b.leads || []).map((l) => [l.key, l])), custByKey = new Map((b.customers || []).map((c) => [c.key, c]));
  const keptLeads = new Map();
  for (const c of b.conversations || []) {
    st.conv_in++; st.msg_in += (c.messages || []).length;
    const msgs = (c.messages || []).filter((m) => inRange(m.at));
    if (!msgs.length) continue;
    st.conv_out++; st.msg_out += msgs.length;
    for (const m of msgs) { st.roles[m.role] = (st.roles[m.role] || 0) + 1; const t = m.type || "text"; st.types[t] = (st.types[t] || 0) + 1; }
    buf.conversations.push({ ...c, messages: msgs });
    if (c.lead_key && leadByKey.has(c.lead_key)) {
      const l = leadByKey.get(c.lead_key);
      const firstCust = msgs.find((m) => m.role === "customer")?.at ?? msgs[0].at;
      const prev = keptLeads.get(l.key);
      const opened = prev && Date.parse(prev.opened_at) < Date.parse(firstCust) ? prev.opened_at : firstCust;   // 同一 lead 多段對話取最早
      const closedOk = l.closed_at && inRange(l.closed_at);
      if (l.closed_at && !closedOk) st.closed_cleared++;
      const { first_real_at, ...rest } = l;   // 交給匯入器從期間內訊息算
      keptLeads.set(l.key, { ...rest, opened_at: opened, closed_at: closedOk ? l.closed_at : null, outcome: closedOk ? l.outcome : "" });
    }
    const cu = custByKey.get(c.customer_key); if (cu && !buf.customers.some((x) => x.key === cu.key)) buf.customers.push(cu);
  }
  for (const l of keptLeads.values()) { buf.leads.push(l); const cu = custByKey.get(l.customer_key); if (cu && !buf.customers.some((x) => x.key === cu.key)) buf.customers.push(cu); }
  const keep = (arr, at) => (arr || []).filter((x) => inRange(at(x)) && (!x.lead_key || keptLeads.has(x.lead_key)));
  buf.appointments.push(...keep(b.appointments, (x) => x.proposed_at)); buf.visits.push(...keep(b.visits, (x) => x.visited_at)); buf.deals.push(...keep(b.deals, (x) => x.closed_at));
  buf.deal_reports.push(...(b.deal_reports || []).filter((x) => inRange(x.reported_at))); buf.appraisals.push(...(b.appraisals || []).filter((x) => inRange(x.reported_at)));
  buf.assignments.push(...(b.assignments || []).filter((x) => inRange(x.at)));
  st.reports = buf.deal_reports.length; st.appraisals = buf.appraisals.length;
  flush();
  process.stdout.write(`  ${f}：對話 ${st.conv_out}/${st.conv_in}，訊息 ${st.msg_out}/${st.msg_in}\r`);
}
flush(true);
console.log(`\n寫了 ${outN} 批到 ${outDir}（每批最多 ${PER} 段對話）`);
console.log(JSON.stringify({ ...st, conversations_written: written, staff: staffByEmail.size, vehicles: vehByKey.size }, null, 1));
