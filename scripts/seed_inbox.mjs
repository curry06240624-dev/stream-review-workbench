/**
 * 假資料：一個中古車商官方帳號的一天。
 *
 * 全部是虛構的人和對話，沒有任何真實客戶資料 —— 這是瑋瑋提案的第一條紅線。
 * 電話號碼刻意用 0900-000-0xx 這種明顯是假的號段。
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

/* 對話：[顯示名, 電話, 分級, 獲客渠道, 指派給（名字或 null）, [ [方向, 內容], … ] ] */
const CONVOS = [
  ["王先生", "0900-000-011", "A", "meta", "小婷", [
    ["in", "你好 想問一下那台 2021 的 RAV4 還在嗎"],
    ["out", "王先生您好！還在喔，白色那台四萬公里的，一手車"],
    ["in", "可以看實車嗎 我禮拜六有空"],
    ["out", "可以的，禮拜六下午有空嗎？我幫您排時間，車子先幫您洗好"],
    ["in", "下午兩點可以"],
  ]],
  ["陳小姐", "0900-000-022", "S", "ig", "小婷", [
    ["in", "上次看的那台 CX-5 我跟我先生討論過了"],
    ["out", "陳小姐好！怎麼樣呢？有什麼想再確認的都可以問我"],
    ["in", "我們想要 貸款的部分可以再算一次嗎 頭期我們想放 15 萬"],
    ["out", "沒問題！頭期 15 萬的話貸 57 萬，60 期月付大概 11,200，我等等把正式試算單傳給您"],
  ]],
  ["林大哥", "0900-000-033", "B", "line_search", "阿凱", [
    ["in", "請問你們收車嗎"],
    ["out", "有的！林大哥您的車是什麼車款年份呢？我請估價的同事幫您看"],
    ["in", "2018 Altis 跑十二萬"],
    ["out", "了解，這台市況還不錯，方便給我幾張外觀跟內裝的照片嗎？我先幫您抓一個範圍"],
  ]],
  ["張太太", "0900-000-044", "B", "meta", null, [
    ["in", "你好 我在 FB 看到那台白色的休旅車"],
    ["in", "請問多少錢"],
  ]],
  ["黃先生", "0900-000-055", "C", "ig", null, [
    ["in", "有休旅車嗎"],
  ]],
  ["吳小姐", "0900-000-066", "A", "line_search", null, [
    ["in", "我上禮拜有去看車 是一位阿凱先生接待的"],
    ["in", "想問那台 Yaris 還有沒有 我決定要了"],
  ]],
  ["劉先生", "0900-000-077", "C", "meta", "阿凱", [
    ["in", "分期最低頭款多少"],
    ["out", "劉先生好，看車價跟條件，最低有零頭款的方案，方便問您看的是哪一台嗎？"],
  ]],
  ["蔡小姐", "0900-000-088", "B", "ig", null, [
    ["in", "你們營業到幾點"],
    ["in", "我下班比較晚 大概八點才會到"],
  ]],
];

const H = (n) => new Date(Date.now() - n * 3600_000).toISOString();

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
// 已存在的話要把 id 撈回來
const ml = await api("/api/members");
for (const u of ml.members || []) if (MEMBERS.some((x) => x.name === u.name)) ids[u.name] = u.id;

const seeded = await api("/api/seed-inbox", {
  contacts: CONVOS.map(([name, phone, grade, source, agent, msgs], i) => ({
    display_name: name, phone, grade, source,
    channel_uid: "Ufake" + String(i + 1).padStart(4, "0"),
    assigned_to: agent ? ids[agent] ?? null : null,
    messages: msgs.map(([dir, text], k) => ({
      direction: dir, text,
      sender_user_id: dir === "out" && agent ? ids[agent] ?? null : null,
      created_at: H(CONVOS.length - i + (msgs.length - k) * 0.3),
    })),
  })),
});
if (!seeded.ok) { console.error("\n寫入失敗：", seeded.message || seeded.status); process.exit(1); }
console.log(`\n寫入 ${seeded.contacts} 位客戶、${seeded.conversations} 個對話、${seeded.messages} 則訊息`);
console.log("\n測試帳號（密碼都是 test-pass-123）：");
console.log("  boss@test.local      老闆 admin      看得到全部");
console.log("  operator@test.local  運營 阿哲       看得到全部，可以指派");
console.log("  agent1@test.local    訊息手 小婷     只看得到指派給她的");
console.log("  agent2@test.local    訊息手 阿凱     只看得到指派給他的");
