/**
 * 匯入前先驗 bundle：結構、參照、去識別化。
 *   node scripts/validate_bundle.mjs bundle.json
 * 有錯就列出來、exit 1；只有警告（個資疑似、缺選填欄）exit 0。
 * 格式定義：src/model/bundle.ts；欄位怎麼來：docs/DATA_COLLECTION.md
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("用法：node scripts/validate_bundle.mjs bundle.json"); process.exit(2); }
let b;
try { b = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error("讀不到或不是 JSON：", e.message); process.exit(2); }

const errors = [], warns = [];
const err = (m) => errors.push(m), warn = (m) => warns.push(m);
const isIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));
const arr = (k, required = true) => { const v = b[k]; if (v === undefined) { if (required) err(`缺 ${k} 陣列`); return []; } if (!Array.isArray(v)) { err(`${k} 要是陣列`); return []; } return v; };

/* ── 頂層 ── */
const SYSTEMS = ["mock", "super8_browser", "super8_export", "sheet", "api", "line_export", "line_oa_export"];
if (!SYSTEMS.includes(b.source_system)) err(`source_system 要是 ${SYSTEMS.join("|")}，現在是 ${JSON.stringify(b.source_system)}`);
if (!isIso(b.generated_at)) err("generated_at 要是 ISO 時間");
const teams = new Set(arr("teams"));
const staff = arr("staff"), vehicles = arr("vehicles"), customers = arr("customers"), leads = arr("leads"), conversations = arr("conversations");
const appointments = arr("appointments"), visits = arr("visits"), deals = arr("deals"), assignments = arr("assignments", false), reports = arr("deal_reports", false), appraisals = arr("appraisals", false);

/* ── 員工 ── */
const staffNames = new Set(), emails = new Set();
for (const [i, s] of staff.entries()) {
  const at = `staff[${i}]`;
  if (!s.name) err(`${at} 缺 name`);
  if (!["admin", "operator", "agent"].includes(s.role)) err(`${at} role 要是 admin|operator|agent`);
  if (!s.email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s.email)) err(`${at} email 格式不對（登入帳號用）`);
  if (emails.has(s.email)) err(`${at} email 重複：${s.email}`); emails.add(s.email);
  if (s.team && !teams.has(s.team)) err(`${at} team「${s.team}」不在 teams 裡`);
  if (s.job !== undefined && !["chat", "sales", "both", "manager"].includes(s.job)) err(`${at} job 要是 chat|sales|both|manager`);
  if (s.job === undefined && s.role === "agent") warn(`${at} ${s.name} 沒填 job（訊息組還是業務？）會當成兩者都做`);
  staffNames.add(s.name); for (const a of s.aliases ?? []) { if (staffNames.has(a) && a !== s.name) err(`${at} 暱稱「${a}」跟別人的名字或暱稱撞到`); staffNames.add(a); }
}
const staffOk = (n) => n == null || staffNames.has(n);

/* ── 車輛 ── */
const vehKeys = new Set(), plates = new Map();
for (const [i, v] of vehicles.entries()) {
  const at = `vehicles[${i}]`;
  if (!v.key) err(`${at} 缺 key`); if (vehKeys.has(v.key)) err(`${at} key 重複：${v.key}`); vehKeys.add(v.key);
  if (!v.brand || !v.model) err(`${at} 缺 brand/model`);
  if (typeof v.list_price !== "number") err(`${at} list_price 要是數字（元）`);
  if (!(typeof v.cost === "number" || v.cost === null)) err(`${at} cost 要是數字或 null（同行車沒成本就 null）`);
  if (!["in_stock", "reserved", "sold", "peer"].includes(v.stock_status)) err(`${at} stock_status 要是 in_stock|reserved|sold|peer`);
  if (v.plate) { const p = String(v.plate).toUpperCase().replace(/[^A-Z0-9]/g, ""); if (plates.has(p)) warn(`${at} 車牌 ${v.plate} 跟 ${plates.get(p)} 重複`); plates.set(p, v.key); }
  else warn(`${at} ${v.brand} ${v.model} 沒有車牌：送貨囉貼文對不回這台`);
  if (v.list_price && v.list_price < 10000) warn(`${at} list_price ${v.list_price} 看起來是「萬」，要換成元`);
}

/* ── 客戶 ── */
const custKeys = new Set();
const RE_PHONE = /09\d{2}[- ]?\d{3}[- ]?\d{3}/, RE_ID = /[A-Z][12]\d{8}/, RE_REALNAME = /^[一-鿿]{2,4}$/;
for (const [i, c] of customers.entries()) {
  const at = `customers[${i}]`;
  if (!c.key) err(`${at} 缺 key`); if (custKeys.has(c.key)) err(`${at} key 重複：${c.key}`); custKeys.add(c.key);
  if (!c.display_name) err(`${at} 缺 display_name`);
  if (!c.pseudonym) err(`${at} 缺 pseudonym（畫面顯示用化名，例如 客戶#001）`);
  if (c.phone && RE_PHONE.test(c.phone)) warn(`${at} phone 是真電話，建議去掉或只留雜湊`);
  if (c.display_name && RE_REALNAME.test(c.display_name.replace(/^\d{1,2}\/\d{1,2}/, "").replace(/-已購車$/, ""))) warn(`${at} display_name「${c.display_name}」像真名，要化名`);
  if (c.first_contact_at && !isIso(c.first_contact_at)) err(`${at} first_contact_at 要是 ISO`);
}

/* ── 旅程 ── */
const leadKeys = new Set();
for (const [i, l] of leads.entries()) {
  const at = `leads[${i}]`;
  if (!l.key) err(`${at} 缺 key`); if (leadKeys.has(l.key)) err(`${at} key 重複`); leadKeys.add(l.key);
  if (!custKeys.has(l.customer_key)) err(`${at} customer_key「${l.customer_key}」不存在`);
  if (l.vehicle_key && !vehKeys.has(l.vehicle_key)) err(`${at} vehicle_key「${l.vehicle_key}」不存在`);
  if (!staffOk(l.staff_name)) err(`${at} staff_name「${l.staff_name}」不在 staff 裡（本名或暱稱都可以）`);
  if (!isIso(l.opened_at)) err(`${at} opened_at 要是 ISO`);
  if (l.first_real_at != null && !isIso(l.first_real_at)) err(`${at} first_real_at 要是 ISO 或 null`);
  if (!["", "sold", "lost"].includes(l.outcome ?? "")) err(`${at} outcome 要是 ''|sold|lost`);
}

/* ── 對話與訊息 ── */
const convKeys = new Set(); let msgN = 0, custMsgs = 0, staffMsgs = 0, imageIdPhotos = 0;
for (const [i, cv] of conversations.entries()) {
  const at = `conversations[${i}]`;
  if (!cv.key) err(`${at} 缺 key`); if (convKeys.has(cv.key)) err(`${at} key 重複`); convKeys.add(cv.key);
  if (!custKeys.has(cv.customer_key)) err(`${at} customer_key「${cv.customer_key}」不存在`);
  if (cv.lead_key && !leadKeys.has(cv.lead_key)) err(`${at} lead_key「${cv.lead_key}」不存在`);
  if (!cv.lead_key) warn(`${at} 沒有 lead_key：這段對話不會進漏斗`);
  if (!staffOk(cv.assigned_staff)) err(`${at} assigned_staff「${cv.assigned_staff}」不在 staff 裡`);
  if (cv.coverage !== undefined && !["full", "partial", "low"].includes(cv.coverage)) err(`${at} coverage 要是 full|partial|low`);
  if (!Array.isArray(cv.messages) || !cv.messages.length) { err(`${at} 沒有 messages`); continue; }
  let prev = "";
  for (const [j, m] of cv.messages.entries()) {
    const mt = `${at}.messages[${j}]`; msgN++;
    if (!isIso(m.at)) err(`${mt} at 要是 ISO`); else if (prev && m.at < prev) warn(`${mt} 時間比前一則早（匯入會重排）`); prev = m.at || prev;
    if (!["customer", "staff", "bot", "system"].includes(m.role)) err(`${mt} role 要是 customer|staff|bot|system`);
    if (typeof m.text !== "string") err(`${mt} text 要是字串（圖片貼圖存「[圖片]」）`);
    if (m.role === "staff") { staffMsgs++; if (!m.staff_name) warn(`${mt} 員工訊息沒有 staff_name，歸因會少算`); else if (!staffNames.has(m.staff_name)) err(`${mt} staff_name「${m.staff_name}」不在 staff 裡（Super 8 縮寫要放進 aliases）`); }
    if (m.role === "customer") { custMsgs++; if (RE_ID.test(m.text || "")) warn(`${mt} 訊息裡有身分證字號（匯入器會抹，但最好在這裡就去掉）`); }
    if (m.type && m.type !== "text" && /行照|身分證|證件|駕照/.test(m.text || "")) imageIdPhotos++;
    if (m.via !== undefined && !["super8", "line_oa", "call", "bot"].includes(m.via)) err(`${mt} via 要是 super8|line_oa|call|bot`);
  }
}
if (conversations.length && staffMsgs === 0) warn("所有對話都沒有員工訊息：確認匯出有包含回覆（Super 8 匯出不含官方後台回覆，反之亦然）");

/* ── 指派、預約、到店、成交 ── */
for (const [i, a] of assignments.entries()) { const at = `assignments[${i}]`; if (!convKeys.has(a.conversation_key)) err(`${at} conversation_key 不存在`); if (!staffOk(a.to_staff) || !a.to_staff) err(`${at} to_staff 不在 staff 裡`); if (!isIso(a.at)) err(`${at} at 要是 ISO`); }
for (const [i, a] of appointments.entries()) { const at = `appointments[${i}]`; if (!leadKeys.has(a.lead_key)) err(`${at} lead_key 不存在`); if (!["proposed", "booked", "rescheduled", "cancelled", "no_show", "completed"].includes(a.status)) err(`${at} status 不合法`); if (!isIso(a.proposed_at) || !isIso(a.status_at)) err(`${at} 時間要是 ISO`); }
for (const [i, v] of visits.entries()) {
  const at = `visits[${i}]`;
  if (!leadKeys.has(v.lead_key)) err(`${at} lead_key 不存在`); if (!isIso(v.visited_at)) err(`${at} visited_at 要是 ISO`);
  if (!staffOk(v.staff_name)) err(`${at} staff_name 不在 staff 裡`);
  if (v.source !== undefined && !["ledger", "reception", "chat"].includes(v.source)) err(`${at} source 要是 ledger|reception|chat`);
  if (v.source !== "reception") warn(`${at} 不是接待群來的到店（source=reception）；真資料的到店應該都來自接待群`);
}
for (const [i, d] of deals.entries()) {
  const at = `deals[${i}]`;
  if (!custKeys.has(d.customer_key)) err(`${at} customer_key 不存在`); if (d.lead_key && !leadKeys.has(d.lead_key)) err(`${at} lead_key 不存在`);
  if (!["sold", "lost"].includes(d.status)) err(`${at} status 要是 sold|lost`); if (!isIso(d.closed_at)) err(`${at} closed_at 要是 ISO`);
  if (d.status === "sold" && !(typeof d.cost === "number" || d.cost === null)) err(`${at} cost 要是數字或 null`);
  if (d.cost_source !== undefined && !["ledger", "sheet", "accounting", "none"].includes(d.cost_source)) err(`${at} cost_source 不合法`);
}
for (const [i, r] of reports.entries()) { const at = `deal_reports[${i}]`; if (!isIso(r.reported_at)) err(`${at} reported_at 要是 ISO`); if (!r.raw_text) err(`${at} 缺 raw_text（送貨囉原文）`); if (r.reported_by && !staffNames.has(r.reported_by)) warn(`${at} 發文人「${r.reported_by}」不在 staff 暱稱裡，畫面會標「暱稱表要補」`); }
for (const [i, r] of appraisals.entries()) { const at = `appraisals[${i}]`; if (!isIso(r.reported_at)) err(`${at} reported_at 要是 ISO`); if (!r.raw_text) err(`${at} 缺 raw_text（估車原文）`); }

/* ── 報告 ── */
console.log(`來源 ${b.source_system}：員工 ${staff.length}、車 ${vehicles.length}、客戶 ${customers.length}、旅程 ${leads.length}、對話 ${conversations.length}（訊息 ${msgN}：客戶 ${custMsgs}／員工 ${staffMsgs}）、到店 ${visits.length}、成交帳本 ${deals.length}、送貨囉 ${reports.length}、估車 ${appraisals.length}`);
if (imageIdPhotos) warn(`${imageIdPhotos} 則證件照片訊息：匯入器會替換成「[證件照片，已略過]」`);
for (const w of warns.slice(0, 30)) console.log("  ⚠ " + w); if (warns.length > 30) console.log(`  ⚠ …還有 ${warns.length - 30} 個警告`);
for (const e of errors.slice(0, 30)) console.log("  ✗ " + e); if (errors.length > 30) console.log(`  ✗ …還有 ${errors.length - 30} 個錯誤`);
console.log(errors.length ? `\n✗ ${errors.length} 個錯誤，修好再匯入` : `\n✓ 可以匯入${warns.length ? `（${warns.length} 個警告）` : ""}`);
process.exit(errors.length ? 1 : 0);
