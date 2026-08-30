/**
 * 假資料：一個中古車商官方帳號的七天。
 *
 * 全部是虛構的人和對話，沒有任何真實客戶資料 —— 這是瑋瑋提案的第一條紅線。
 * 電話號碼刻意用 0900-000-0xx 這種明顯是假的號段。
 *
 * 為什麼要生七天而不是幾筆就好：
 *   現場狀況頁的「尖峰時段」與「積壓趨勢」是從真實時間分布算出來的。
 *   資料只有 8 小時的話，那兩張圖畫出來是雜訊冒充洞察。寧可資料是假的，
 *   也不能讓「從資料算出來的結論」是假的。
 *
 * 節奏照中古車客人的作息（不是均勻亂數）：
 *   早上 10–12 點一波、晚上 8–10 點最大波（下班後看車），凌晨幾乎沒有。
 *   週末整體比平日多。回覆延遲多數 5–40 分，少數拖過夜 —— 這樣才有
 *   SLA 違反可看，不然畫面上永遠是綠的，等於沒有在測東西。
 *
 * 跑法：node scripts/seed_inbox.mjs [base_url]
 * 需要先有 admin 帳號（setup 過），會用 boss@test.local 登入。
 */
const BASE = process.argv[2] || "http://127.0.0.1:8788";
const ADMIN = { email: "boss@test.local", password: "test-pass-123" };

let cookie = "";
async function api(path, body, method) {
  const r = await fetch(BASE + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...j };
}

const MEMBERS = [
  { name: "阿哲", email: "operator@test.local", password: "test-pass-123", role: "operator" },
  { name: "小婷", email: "agent1@test.local",   password: "test-pass-123", role: "agent" },
  { name: "阿凱", email: "agent2@test.local",   password: "test-pass-123", role: "agent" },
];
const AGENTS = ["小婷", "阿凱"];

/* 固定亂數：每次跑出來一樣，不然每次 demo 數字都在跳，沒辦法對帳 */
let _s = 20260829;
const rnd = () => (_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

/* 一天 24 小時的相對進線權重。10–12 一波、20–22 最大波、凌晨幾乎沒有。 */
const HOUR_W = [1,1,0,0,0,0,1,2,4,7,11,10, 8,7,6,6,7,9, 12,16,18,15, 9,4];

const SURNAME = "陳林黃張李王吳劉蔡楊許鄭謝洪郭曾廖賴徐周葉蘇莊呂".split("");
const TITLE = ["先生", "小姐", "太太", "大哥", "姊"];
const SOURCES = ["meta", "ig", "line_search"];
const GRADES = ["S", "A", "B", "C"];

/* 對話腳本。每組是一種真實會發生的來意，長度不一。 */
const SCRIPTS = [
  [["in","你好 想問一下那台 {car} 還在嗎"],["out","{n}您好！還在喔，我把實車照片傳給您"],
   ["in","可以看實車嗎 我這禮拜有空"],["out","可以的，您方便哪一天？我先幫您把車洗好"],["in","禮拜六下午"]],
  [["in","{car} 這台多少錢"],["out","{n}好，這台開價 {price} 萬，直播下訂還有折扣"],
   ["in","可以再談嗎"],["out","可以聊，您先來看車，車況滿意我們再談價格"]],
  [["in","分期最低頭款多少"],["out","{n}好，看車價跟條件，最低有零頭款的方案，方便問您看的是哪一台嗎？"]],
  [["in","頭款十萬 月付大概多少"],["out","{n}好，以 {price} 萬來算，頭期十萬、60 期月付大概 {pay} 元"],
   ["in","了解 我再考慮一下"]],
  [["in","你們營業到幾點"],["in","我下班比較晚 大概八點才會到"]],
  [["in","{car} 有事故嗎"],["out","沒有事故，我們每一台都有第三方認證報告，我拍給您看"],
   ["in","好 麻煩你"],["out","報告傳給您了，四十八項檢測，事故判定無重大事故"]],
  [["in","有休旅車嗎 預算 {price} 萬左右"],["out","{n}好，這個預算有幾台不錯的，我整理給您"]],
  [["in","請問里程數多少"],["out","{car} 這台 {km} 萬公里，一手車，保養紀錄都在"],["in","保固怎麼算"],
   ["out","引擎、變速箱、方向機保固一年或兩萬公里，先到為準，保固書會寫在合約裡"]],
  [["in","我上禮拜有去看車 是一位{ag}接待的"],["in","想問那台 {car} 還有沒有 我決定要了"]],
  [["in","可以幫我估我的舊車嗎"],["out","可以！{n}方便給我車型、年份跟里程嗎？我先幫您抓個範圍"],
   ["in","2016 的 Altis 開了 12 萬"],["out","這台目前市況大概 {price} 萬上下，實車看過才準，您方便帶來嗎"]],
  [["in","請問還有在營業嗎"],["out","有的{n}，我們每天都在，您想看哪一台？"]],
  [["in","{car} 的照片可以多傳幾張嗎 想看內裝"],["out","沒問題，內裝照傳給您了，方向盤跟座椅都很新"],
   ["in","看起來不錯 我約時間過去"]],
];
const CARS = ["RAV4","CR-V","Altis","CX-5","Yaris","Kicks","Corolla Cross","Fit","Vios","Focus","Kuga","Tucson"];

const now = Date.now();
const H = 3600_000, DAY = 24 * H;
const iso = (t) => new Date(t).toISOString();

/* 依 HOUR_W 抽一個時刻：先抽天、再抽小時（照權重）、再抽分鐘 */
function stamp(daysAgo) {
  const d = new Date(now - daysAgo * DAY);
  const total = HOUR_W.reduce((a, b) => a + b, 0);
  let r = rnd() * total, h = 0;
  while (r > HOUR_W[h] && h < 23) { r -= HOUR_W[h]; h++; }
  d.setHours(h, int(0, 59), int(0, 59), 0);
  return d.getTime();
}

const contacts = [];
const usedPhone = new Set();

/* 這 5 位是「現在正在等回覆」的 —— 現場狀況頁一打開就要有東西可看。
   等待時間刻意跨越 SLA：兩通在目標內、三通已經超過。 */
const LIVE = [
  ["王先生","0900-000-011","A","meta","小婷", 12],
  ["陳小姐","0900-000-022","S","ig",  "小婷", 41],
  ["吳小姐","0900-000-066","A","line_search", null, 95],
  ["蔡小姐","0900-000-088","B","ig",  null, 168],
  ["張太太","0900-000-055","B","meta",null, 320],
];

let idx = 0;
for (const [name, phone, grade, source, agent, waitMin] of LIVE) {
  const sc = SCRIPTS[idx % SCRIPTS.length];
  const car = pick(CARS);
  const end = now - waitMin * 60_000;
  const msgs = [];
  // 最後一則一定是客人講的（＝在等我們），前面的往前推
  const trimmed = sc[sc.length - 1][0] === "in" ? sc : [...sc, ["in", "在嗎 想再問一下"]];
  trimmed.forEach(([dir, t], k) => {
    msgs.push({
      direction: dir,
      text: fill(t, name, car, agent),
      sender_user_id: null,
      _agent: dir === "out" ? agent : null,
      created_at: iso(end - (trimmed.length - 1 - k) * int(8, 45) * 60_000),
    });
  });
  contacts.push({ display_name: name, phone, grade, source, assigned_to: agent, messages: msgs });
  usedPhone.add(phone);
  idx++;
}

/* 歷史：過去 7 天，每天 5–8 段對話。全部已經回覆完（最後一則是我方），
   所以不會污染「正在等」的數字，但會餵飽趨勢圖與尖峰圖。 */
for (let d = 7; d >= 0; d--) {
  const perDay = d === 0 ? 4 : int(5, 8);
  for (let i = 0; i < perDay; i++) {
    const name = pick(SURNAME) + pick(TITLE);
    let phone;
    do { phone = "0900-000-" + String(int(100, 999)); } while (usedPhone.has(phone));
    usedPhone.add(phone);
    const agent = pick(AGENTS);
    const sc = SCRIPTS[int(0, SCRIPTS.length - 1)];
    const car = pick(CARS);
    let t = stamp(d);
    const msgs = [];
    for (const [dir, txt] of sc) {
      msgs.push({
        direction: dir, text: fill(txt, name, car, agent),
        sender_user_id: null, _agent: dir === "out" ? agent : null,
        created_at: iso(t),
      });
      // 回覆延遲：八成 5–40 分（正常），兩成 90–600 分（拖到 SLA 違反）
      t += (dir === "in"
        ? (rnd() < 0.8 ? int(5, 40) : int(90, 600))
        : int(3, 90)) * 60_000;
    }
    // 尾巴補一則我方收尾，確保這段不算「在等」
    if (msgs[msgs.length - 1].direction === "in") {
      msgs.push({ direction: "out", text: "好的，有需要隨時跟我說！",
        sender_user_id: null, _agent: agent, created_at: iso(t) });
    }
    contacts.push({
      display_name: name, phone, grade: pick(GRADES), source: pick(SOURCES),
      assigned_to: agent, messages: msgs,
    });
  }
}

function fill(t, name, car, agent) {
  return t
    .replace(/\{car\}/g, car)
    .replace(/\{n\}/g, name)
    .replace(/\{ag\}/g, agent || "同事")
    .replace(/\{price\}/g, String(int(38, 98)))
    .replace(/\{pay\}/g, String(int(8, 16) * 1000 + int(0, 9) * 100))
    .replace(/\{km\}/g, String(int(2, 12)));
}

console.log(`目標：${BASE}\n`);
let r = await api("/api/login", ADMIN);
if (!r.ok) { console.error("登入失敗：", r.message || r.status, "\n先跑 setup 建立 boss@test.local"); process.exit(1); }
console.log("已登入 admin");

const ids = {};
for (const mem of MEMBERS) {
  const res = await api("/api/members", mem);
  if (res.ok) { ids[mem.name] = res.id; console.log(`  建立 ${mem.role.padEnd(8)} ${mem.name}`); }
  else if (res.error === "taken") console.log(`  ${mem.name} 已存在，略過`);
  else console.log(`  ✗ ${mem.name}: ${res.message}`);
}
const ml = await api("/api/members");
for (const u of ml.members || []) if (MEMBERS.some((x) => x.name === u.name)) ids[u.name] = u.id;

const payload = contacts.map((c, i) => ({
  display_name: c.display_name, phone: c.phone, grade: c.grade, source: c.source,
  channel_uid: "Ufake" + String(i + 1).padStart(4, "0"),
  assigned_to: c.assigned_to ? ids[c.assigned_to] ?? null : null,
  messages: c.messages.map((m) => ({
    direction: m.direction, text: m.text,
    sender_user_id: m._agent ? ids[m._agent] ?? null : null,
    created_at: m.created_at,
  })),
}));

// reset:true 只清假資料相關的表（對話/訊息/客戶），帳號與設定保留。
// 這是 demo 環境的重灌鍵，不是正式資料的操作。
const seeded = await api("/api/seed-inbox", { contacts: payload, reset: true });
if (!seeded.ok) { console.error("\n寫入失敗：", seeded.message || seeded.status); process.exit(1); }

const all = payload.flatMap((c) => c.messages.map((m) => m.created_at)).sort();
const spanH = (Date.parse(all[all.length - 1]) - Date.parse(all[0])) / H;
console.log(`\n寫入 ${seeded.contacts} 位客戶、${seeded.conversations} 個對話、${seeded.messages} 則訊息`);
console.log(`時間跨度 ${(spanH / 24).toFixed(1)} 天（${all[0].slice(0, 16)} → ${all[all.length - 1].slice(0, 16)}）`);
console.log("\n測試帳號（密碼都是 test-pass-123）：");
console.log("  boss@test.local      老闆 admin      看得到全部");
console.log("  operator@test.local  運營 阿哲       看得到全部，可以指派");
console.log("  agent1@test.local    訊息手 小婷     只看得到指派給她的");
console.log("  agent2@test.local    訊息手 阿凱     只看得到指派給他的");
