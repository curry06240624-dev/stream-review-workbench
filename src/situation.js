/**
 * 現場狀況 —— 指揮中心的主畫面。
 *
 * 跟「總覽」的分工要講清楚，不然兩頁會變成同一頁的兩個版本：
 *   總覽    回答「我們做得怎樣」——累計數字，事後看的
 *   現場狀況 回答「現在誰需要人」——依等待時間排序，當下用的
 *
 * 結構照 Endsley 的三層情境覺知（ISA-101 的骨幹）：
 *   ① 感知 —— 等待佇列：現在誰在等、等多久
 *   ② 理解 —— 結論列：這代表我們有沒有踩到 SLA
 *   ③ 預測 —— 趨勢／尖峰／消化速度：接下來會變好還是變壞
 * 少了第三層就只是儀表板，不是指揮中心。
 *
 * 門檻不寫死：SLA 由 settings 表決定（預設 30 分）。
 * 「多久要回」是老闆的生意決定，不是工程師的常數。
 *
 * 權限與其他頁一致：訊息手只看得到指派給自己的，這頁對他就是「我的待辦」。
 */

import { canSeeAll } from "./inbox.js";
import { coverageOfWaiting } from "./autoreply.js";

const MIN = 60000, HOUR = 3600000;
export const DEFAULT_SLA = 30;

/* ⚠️ Workers 跑在 UTC，但生意在台灣。直接用 getHours() 會把晚上 8 點的尖峰
   算成中午 12 點 —— 那會讓「尖峰時段」這張圖建議老闆在凌晨排人，
   是錯的建議不是小瑕疵。所有「一天中的第幾小時」一律走這個換算。 */
const TZ_MIN = 480;                                    // 台灣 UTC+8
const localHour = (t) => new Date(Date.parse(t) + TZ_MIN * MIN).getUTCHours();

export async function getSla(db) {
  const r = await db.first("SELECT value FROM settings WHERE key = 'sla_minutes'");
  const n = Number(r && r.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SLA;
}

export async function situation(db, me, nowIso) {
  const all = canSeeAll(me.role);
  const mine = all ? "" : ` AND c.assigned_to = ${Number(me.id)}`;
  const now = Date.parse(nowIso);
  const mins = (t) => (t ? Math.max(0, Math.round((now - Date.parse(t)) / MIN)) : null);

  const sla = await getSla(db);
  const bad = sla * 4;                    // 四倍 SLA＝嚴重，不另外編一個數字

  /* ── ① 感知：誰在等 ─────────────────────────────────────── */
  const rows = await db.all(
    `SELECT c.id, c.assigned_to, c.unread, c.last_message_at,
            ct.display_name, ct.grade, ct.phone,
            u.name AS agent_name,
            (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id
              ORDER BY m.id DESC LIMIT 1) AS last_dir,
            (SELECT m.text FROM messages m WHERE m.conversation_id = c.id
              ORDER BY m.id DESC LIMIT 1) AS last_text
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN users u ON u.id = c.assigned_to
      WHERE c.status = 'open'${mine}`);

  const waiting = rows
    .filter((r) => r.last_dir === "in")          // 客人講完，還沒人回
    .map((r) => ({
      id: r.id, name: r.display_name, grade: r.grade, phone: r.phone,
      assigned_to: r.assigned_to, agent_name: r.agent_name,
      last_text: r.last_text, wait_min: mins(r.last_message_at),
    }))
    .sort((a, b) => b.wait_min - a.wait_min);    // 等最久的排最前面

  const longest = waiting.length ? waiting[0].wait_min : 0;
  const breached = waiting.filter((w) => w.wait_min >= sla).length;

  /* ── ③ 預測 A：積壓趨勢 ───────────────────────────────────
     用每小時的「進線 − 回覆」近似佇列深度的變化。
     ⚠️ 這是近似值，不是重建歷史快照 —— 我們沒有存每小時的佇列長度。
     方向（在變好還變壞）可信；絕對值只能當參考。 */
  const since12 = new Date(now - 12 * HOUR).toISOString();
  const recent = await db.all(
    `SELECT m.created_at, m.direction
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.created_at >= ?${mine}`, since12);
  const hourly = [];
  for (let i = 11; i >= 0; i--) {
    const s = now - (i + 1) * HOUR, e = now - i * HOUR;
    const inB = recent.filter((m) => { const t = Date.parse(m.created_at); return t >= s && t < e && m.direction === "in"; }).length;
    const outB = recent.filter((m) => { const t = Date.parse(m.created_at); return t >= s && t < e && m.direction === "out"; }).length;
    hourly.push({ hour: new Date(e + TZ_MIN * MIN).getUTCHours(),
                  incoming: inB, outgoing: outB, net: inB - outB });
  }
  const firstHalf = hourly.slice(0, 6).reduce((a, h) => a + h.net, 0);
  const lastHalf = hourly.slice(6).reduce((a, h) => a + h.net, 0);
  const trend = lastHalf < firstHalf - 1 ? "better"
    : lastHalf > firstHalf + 1 ? "worse" : "flat";

  /* ── ③ 預測 B：尖峰時段 ───────────────────────────────────
     資料不足 3 天就不回傳 —— 用 1 天的資料畫「一天的節奏」是雜訊冒充洞察。 */
  const span = await db.first(
    `SELECT MIN(m.created_at) AS a, MAX(m.created_at) AS b, COUNT(*) AS n
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE 1=1${mine}`);
  const spanDays = span && span.a ? (Date.parse(span.b) - Date.parse(span.a)) / (24 * HOUR) : 0;
  let peak = null;
  if (spanDays >= 3) {
    const inbound = await db.all(
      `SELECT m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'in'${mine}`);
    const by = new Array(24).fill(0);
    for (const m of inbound) by[localHour(m.created_at)]++;
    peak = by.map((n, h) => ({ hour: h, n }));
  }

  /* ── ③ 預測 C：消化速度 ───────────────────────────────────
     近 4 小時的實際回覆速率。⚠️ 推估「幾小時清完」的前提是**不再有新訊息進來**，
     這句一定要印在畫面上，不然是誤導。 */
  const since4 = new Date(now - 4 * HOUR).toISOString();
  const rep = await db.first(
    `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.direction='out' AND m.created_at >= ?${mine}`, since4);
  const ratePerHour = (rep.n || 0) / 4;
  const burn = {
    replies_4h: rep.n || 0,
    rate_per_hour: Math.round(ratePerHour * 10) / 10,
    hours_to_clear: ratePerHour > 0 ? Math.round(waiting.length / ratePerHour * 10) / 10 : null,
  };

  /* 真正的 First Response Time：客人第一則 → 我方第一則回覆。
     取中位數不取平均 —— 一通拖三天會把平均拉爛，中位數才代表常態。 */
  const frtRows = await db.all(
    `SELECT c.id,
            (SELECT MIN(m.created_at) FROM messages m
              WHERE m.conversation_id=c.id AND m.direction='in') AS first_in,
            (SELECT MIN(m.created_at) FROM messages m
              WHERE m.conversation_id=c.id AND m.direction='out') AS first_out
       FROM conversations c WHERE 1=1${mine}`);
  const frts = frtRows
    .filter((r) => r.first_in && r.first_out && Date.parse(r.first_out) > Date.parse(r.first_in))
    .map((r) => Math.round((Date.parse(r.first_out) - Date.parse(r.first_in)) / MIN))
    .sort((a, b) => a - b);
  const frtMedian = frts.length ? frts[Math.floor(frts.length / 2)] : null;

  /* 人員負載：只有管理職看得到別人的 */
  let load = [];
  if (all) {
    const users = await db.all(
      `SELECT u.id, u.name, u.role,
              (SELECT COUNT(*) FROM conversations c
                WHERE c.assigned_to = u.id AND c.status='open') AS assigned
         FROM users u WHERE u.role IN ('agent','operator') ORDER BY u.name`);
    load = users.map((u) => {
      const q = waiting.filter((w) => w.assigned_to === u.id);
      return {
        id: u.id, name: u.name, role: u.role, assigned: u.assigned,
        waiting: q.length, longest_min: q.length ? q[0].wait_min : 0,
      };
    });
  }

  /* 事件流：訊息與指派合併成一條時間軸。指派是管理動作，
     老闆要看得到誰把誰的對話轉給誰 —— 那是收件匣看不到的。 */
  const msgs = await db.all(
    `SELECT m.created_at AS at, m.direction, m.text, u.name AS who,
            ct.display_name AS contact
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE 1=1${mine}
      ORDER BY m.created_at DESC LIMIT 14`);
  let assigns = [];
  if (all) {
    assigns = await db.all(
      `SELECT a.created_at AS at, ub.name AS by_name, ut.name AS to_name,
              ct.display_name AS contact
         FROM assignment_log a
         JOIN conversations c ON c.id = a.conversation_id
         JOIN contacts ct ON ct.id = c.contact_id
         LEFT JOIN users ub ON ub.id = a.by_user_id
         LEFT JOIN users ut ON ut.id = a.to_user_id
        ORDER BY a.id DESC LIMIT 8`);
  }
  const events = [
    ...msgs.map((m) => ({
      at: m.at, ago: mins(m.at), kind: m.direction === "in" ? "in" : "out",
      contact: m.contact, who: m.who || "", text: (m.text || "").slice(0, 60),
    })),
    ...assigns.map((a) => ({
      at: a.at, ago: mins(a.at), kind: "assign",
      contact: a.contact, who: a.by_name || "",
      text: a.to_name ? "指派給 " + a.to_name : "取消指派",
    })),
  ].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 16);

  /* 自動回覆能接住幾通 —— 把功能變成一個數字。
     沒有這個數字，「要不要開自動回覆」永遠是感覺之爭。 */
  const coverage = await coverageOfWaiting(db, waiting);

  return {
    now: nowIso,
    can_see_all: all,
    coverage,
    sla: { target_min: sla, breached, at_risk: waiting.length - breached },
    thresholds: { warn: sla, bad },
    stats: {
      waiting: waiting.length,
      unassigned: waiting.filter((w) => !w.assigned_to).length,
      longest_min: longest,
      over_warn: breached,
      incoming_24h: 0, outgoing_24h: 0,   // 由 hourly 取代，保留欄位避免舊前端壞掉
      frt_median: frtMedian,
    },
    hourly, trend, peak, burn,
    data_days: Math.round(spanDays * 10) / 10,
    waiting: waiting.slice(0, 30),
    load,
    events,
  };
}
