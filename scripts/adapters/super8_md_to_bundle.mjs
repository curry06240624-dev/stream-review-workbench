/**
 * Super 8 瀏覽器匯出（all-conversations.md）＋ 車源表 CSV → NormalizedBundle（去識別化）。
 *   node scripts/adapters/super8_md_to_bundle.mjs <all-conversations.md> [車源表.csv] <out.json>
 *
 * 匯出格式（2026-09-06 實檔）：每段對話一個「# 顯示名稱」；區塊用 --- 分隔；
 *   區塊＝發送者 / 時間（YYYY-MM-DD HH:MM 或只有 HH:MM）/ 標籤（客服人員｜聊天機器人｜群發訊息）/ 內容行…
 *   只有時間沒日期的，用前一個「YYYY-MM-DD」分隔區塊的日期；快速回覆模板會在標籤後多出「作者 / 建立時間」兩行，略過。
 * 去識別化：顯示名稱的人名換成 客戶#NN，保留公司自己的標記（B@、8/25、+24、-已購車、❌）；電話與身分證由匯入器再抹一次。
 * 對照表（客戶#NN ↔ 原顯示名稱）只寫在本機 out.json 旁的 *.map.json，不要上傳。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sheetToVehicles, statusStaff } from "../../src/engine/csv.ts";

const [,, mdPath, a3, a4] = process.argv;
const csvPath = a4 ? a3 : null, outPath = a4 ?? a3;
if (!mdPath || !outPath) { console.error("用法：node scripts/adapters/super8_md_to_bundle.mjs <all-conversations.md> [車源表.csv] <out.json>"); process.exit(2); }

const TZ = "+08:00";
const md = readFileSync(mdPath, "utf8").replace(/\r\n/g, "\n");
const exportDate = (md.match(/Exported: (\d{4}-\d{2}-\d{2})/)?.[1]) ?? new Date().toISOString().slice(0, 10);
const BOT = "聊天機器人", OA = "浦森汽車";
const RE_FULL = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})$/, RE_TIME = /^(\d{1,2}):(\d{2})$/, RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (date, hh, mm) => new Date(`${date}T${String(hh).padStart(2, "0")}:${mm}:00${TZ}`).toISOString();
/* 這家 OA 的選單與快速回覆按鈕文字（2026-09-06 從 3,595 則訊息整理）；短、常以 emoji 開頭 */
const MENU_RE = /^(線上車庫|熱銷車款|本週新進車款|進口|國產|轎車|休旅|跑車|三天快速交車專區|瑕疵福利|出清專區|汽車地圖|加入會員|我要賣車|圓夢計畫|優惠車款|進口車|國產車|我看到影片加入|請點選!?|了解|是的)$/;
const MENU_PREFIX = /^(我非常想立即知道這台車的資訊|請給我現金總價|我要一年車貸活動|我要了解|我想了解)/;
const isMenuClick = (t) => { const s = t.replace(/^[\p{Extended_Pictographic}️‍\s]+/u, "").trim(); return s.length <= 20 && (MENU_RE.test(s) || MENU_PREFIX.test(s)); };

/* ── 切對話 ── */
const parts = md.split(/\n(?=# )/).filter((p) => p.startsWith("# ") && !p.startsWith("# Super 8"));
const customers = [], leads = [], conversations = [];
const staffSeen = new Map();   // name → msgs
const nameMap = {};            // 客戶#NN → 原顯示名稱（只留本機）
let n = 0;
const parseName = (raw) => {
  const s = raw.trim();
  const grade = s.match(/^([ABCS]\+?)@/)?.[1] ?? "";
  const rest = s.replace(/^[ABCS]\+?@/, "");
  const dm = rest.match(/^(\d{1,2})\/(\d{1,2})(?:\+(\d{2}))?/);
  const sold = /已購車/.test(s), blocked = /❌/.test(s);
  let firstAt = null;
  if (dm) { const y = dm[3] ? 2000 + Number(dm[3]) : Number(exportDate.slice(0, 4)); const cand = new Date(`${y}-${String(dm[1]).padStart(2, "0")}-${String(dm[2]).padStart(2, "0")}T09:00:00${TZ}`); firstAt = (cand.getTime() > Date.parse(exportDate + "T23:59:59" + TZ) ? new Date(cand.setFullYear(y - 1)) : cand).toISOString(); }
  const tag = `${grade ? grade + "@" : ""}${dm ? dm[0] : ""}`;
  return { grade, tag, sold, blocked, firstAt };
};

for (const part of parts) {
  const lines = part.split("\n");
  const title = lines[0].replace(/^# /, "").trim();
  const src = part.match(/Source: (\S+)/)?.[1] ?? "";
  const convId = src.match(/conversation\/([a-f0-9]+)/)?.[1] ?? `conv${n + 1}`;
  const userId = src.match(/customer\/(U[a-f0-9]+)/)?.[1] ?? `user${n + 1}`;
  n++;
  const meta = parseName(title);
  const pseudonym = `客戶#${String(n).padStart(3, "0")}`;
  const display = `${meta.tag ? meta.tag + " " : ""}${pseudonym}${meta.sold ? "-已購車" : ""}${meta.blocked ? "❌" : ""}`;
  nameMap[pseudonym] = title;

  const body = part.slice(part.indexOf("\n---\n"));
  const blocks = body.split(/\n---\n/).map((b) => b.split("\n").filter((l) => l.trim() !== "")).filter((b) => b.length);
  let curDate = null; const msgs = [];
  for (const b of blocks) {
    if (b.length === 1 && RE_DATE.test(b[0].trim())) { curDate = b[0].trim(); continue; }
    if (b.length === 1 && /已加入聊天$/.test(b[0])) continue;
    if (b.length < 2) continue;
    const sender = b[0].trim(); const t = b[1].trim();
    let at = null; const mf = t.match(RE_FULL), mt = t.match(RE_TIME);
    if (mf) { at = iso(mf[1], mf[2], mf[3]); curDate = mf[1]; }
    else if (mt) at = iso(curDate ?? exportDate, mt[1], mt[2]);
    else continue;                                                  // 不是訊息區塊
    let i = 2; let role = "customer", label = "", staffName;
    if (sender === BOT) { role = "bot"; if (b[i] === BOT) i++; }
    else if (sender === OA) { role = "bot"; staffName = OA; if (b[i] === "群發訊息") { label = "群發訊息"; i++; } }
    else if (b[i] === "客服人員") { role = "staff"; staffName = sender; label = "客服人員"; i++;
      if (b[i] && b[i + 1] && RE_FULL.test(b[i + 1].trim()) && !RE_TIME.test(b[i].trim())) i += 2;   // 快速回覆模板：作者 / 建立時間
    } else if (sender !== title) { role = "staff"; staffName = sender; }               // 沒標籤但也不是客戶：當員工
    let content = b.slice(i);
    /* Super 8 把「回覆某則」畫成：「X回覆了你」＋被引用的那句＋自己的回覆 → 去掉前兩行，只留回覆本文 */
    if (content[0] && /回覆了你$/.test(content[0].trim())) content = content.slice(2);
    const images = content.filter((l) => /^\[(Image|VIDEO|Sticker)/i.test(l)).length;
    const text = content.filter((l) => !/^\[(Image|VIDEO|Sticker)/i.test(l)).join("\n").trim();
    let type = "text"; let finalText = text;
    if (!text && images) { type = /^\[VIDEO/i.test(content[0]) ? "video" : "image"; finalText = type === "video" ? "[影片]" : "[圖片]"; }
    else if (images) finalText = `${text}\n[圖片]`;
    if (!finalText) continue;
    /* 客戶按選單／快速回覆按鈕（不是自己打字）：標 menu，引擎不拿它算有來有往與回覆速度 */
    if (role === "customer" && type === "text" && isMenuClick(finalText)) type = "menu";
    const m = { at, role, text: finalText.slice(0, 4000), type };
    if (staffName) m.staff_name = staffName;
    if (role === "bot" && staffName === OA) m.via = "line_oa";     // 群發＝官方帳號推播
    else if (role === "staff") m.via = "super8";
    msgs.push(m);
    if (role === "staff") staffSeen.set(staffName, (staffSeen.get(staffName) ?? 0) + 1);
  }
  if (!msgs.length) continue;
  msgs.sort((x, y) => x.at.localeCompare(y.at));
  const firstCust = msgs.find((m) => m.role === "customer") ?? msgs[0];
  const custKey = userId, leadKey = `L:${convId}`, convKey = convId;
  customers.push({ key: custKey, display_name: display, pseudonym, phone: "", grade: meta.grade || "C", external_key: userId, first_contact_at: meta.firstAt ?? firstCust.at, blocked: meta.blocked ? 1 : 0 });
  const counts = {}; for (const m of msgs) if (m.role === "staff") counts[m.staff_name] = (counts[m.staff_name] ?? 0) + 1;
  const assigned = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  leads.push({ key: leadKey, customer_key: custKey, staff_name: assigned, vehicle_key: null, source: "line_search", opened_at: firstCust.at, closed_at: null, outcome: "" });
  conversations.push({ key: convKey, customer_key: custKey, lead_key: leadKey, channel: "line", assigned_staff: assigned, messages: msgs });
}

/* ── 員工（從發言者來；老闆＝昱孝陳；其他先當「線上也回」，工作性質等名冊）── */
const BOSS = "昱孝陳";
const staff = [{ name: "老闆", role: "admin", team: "管理", email: "boss@test.local", job: "manager" }];
let k = 0;
for (const [name, msgsN] of [...staffSeen.entries()].sort((a, b) => b[1] - a[1])) {
  k++;
  const isBoss = name === BOSS;
  staff.push({ name, role: isBoss ? "operator" : "agent", team: isBoss ? "管理" : "訊息組", email: `${isBoss ? "weiwei" : "s" + k}@pusen.local`, job: isBoss ? "manager" : "both", aliases: [] });
}

/* ── 車源表（可選）── */
let vehicles = [], sheetNote = "";
if (csvPath) {
  const { vehicles: vs, skipped } = sheetToVehicles(readFileSync(csvPath, "utf8"));
  vehicles = vs.map((v, i) => ({ key: v.plate_norm ? `sheet:${v.plate_norm}` : `sheet:row${i + 1}`, brand: v.brand, model: v.model, year: v.year ?? 0, body_type: "", list_price: v.list_price ?? 0, cost: v.cost, stock_status: v.stock_status, plate: v.plate, color: v.color, trim: v.trim, mileage_km: v.mileage_km, stock_in_at: v.stock_in_at, cert: v.cert, sell_price: v.sell_price, source: v.stock_status === "peer" ? "peer" : "stock", status_text: v.status_text }));
  const reps = [...new Set(vs.map((v) => statusStaff(v.status_text)).filter(Boolean))];
  sheetNote = `車源表 ${vs.length} 台（略過 ${skipped} 列）；狀態括號裡的業務：${reps.join("、") || "—"}`;
}

const bundle = { source_system: "super8_browser", generated_at: new Date().toISOString(), teams: ["管理", "訊息組"], staff, vehicles, customers, leads, conversations, appointments: [], visits: [], deals: [], assignments: [] };
writeFileSync(outPath, JSON.stringify(bundle, null, 1));
writeFileSync(outPath.replace(/\.json$/, "") + ".map.json", JSON.stringify(nameMap, null, 1));

const msgN = conversations.reduce((a, c) => a + c.messages.length, 0);
const byRole = {}; for (const c of conversations) for (const m of c.messages) byRole[m.role] = (byRole[m.role] ?? 0) + 1;
const dates = conversations.flatMap((c) => c.messages.map((m) => m.at)).sort();
console.log(`對話 ${conversations.length}、訊息 ${msgN}（${Object.entries(byRole).map(([r, v]) => `${r} ${v}`).join("、")}）、期間 ${dates[0]?.slice(0, 10)} → ${dates[dates.length - 1]?.slice(0, 10)}`);
console.log(`員工（依發言數）：${[...staffSeen.entries()].sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n} ${v}`).join("、")}`);
console.log(`客戶分級：${JSON.stringify(customers.reduce((a, c) => { a[c.grade] = (a[c.grade] ?? 0) + 1; return a; }, {}))}；已購車 ${customers.filter((c) => /已購車/.test(c.display_name)).length}、❌ ${customers.filter((c) => c.blocked).length}`);
if (sheetNote) console.log(sheetNote);
console.log(`寫出 ${outPath}（對照表 ${outPath.replace(/\.json$/, "")}.map.json，只留本機）`);
