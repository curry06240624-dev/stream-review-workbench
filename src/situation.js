/**
 * 現場狀況 —— 指揮中心的主畫面。
 *
 * 跟「總覽」的分工要講清楚，不然兩頁會變成同一頁的兩個版本：
 *   總覽    回答「我們做得怎樣」——累計數字，事後看的
 *   現場狀況 回答「現在誰需要人」——依等待時間排序，當下用的
 *
 * 這頁唯一的主角是**等待時間**。客服的真正指標不是「有幾通對話」，
 * 是「客人講完話之後等了多久沒人回」。所以：
 *   ‧ 一通對話「在等」的定義＝最後一則是客人講的（direction='in'）
 *   ‧ 佇列一律依等待時間由久到近排，不依時間先後 —— 最久的先處理
 *   ‧ 等待時間直接以分鐘顯示，不做「剛剛／不久前」這種模糊字眼
 *
 * 權限與其他頁一致：訊息手只看得到指派給自己的，這頁對他就是「我的待辦」。
 */

import { canSeeAll } from "./inbox.js";

const MIN = 60000;

/** 兩個門檻，畫面與 API 共用一套判定，不要各算各的 */
export const WAIT_WARN = 60;    // 分鐘：超過就該回了
export const WAIT_BAD = 240;    // 分鐘：太久了

export async function situation(db, me, nowIso) {
  const all = canSeeAll(me.role);
  const mine = all ? "" : ` AND c.assigned_to = ${Number(me.id)}`;
  const now = Date.parse(nowIso);
  const mins = (t) => (t ? Math.max(0, Math.round((now - Date.parse(t)) / MIN)) : null);

  // 進行中的對話 + 最後一則訊息的方向（方向決定「是不是在等我們」）
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

  // 今日進出訊息量。用當地日界線不精確也無所謂 —— 這是節奏指標不是帳
  const since = new Date(now - 24 * 60 * MIN).toISOString();
  const flow = await db.first(
    `SELECT SUM(CASE WHEN m.direction='in'  THEN 1 ELSE 0 END) AS incoming,
            SUM(CASE WHEN m.direction='out' THEN 1 ELSE 0 END) AS outgoing
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.created_at >= ?${mine}`, since);

  // 人員負載：只有管理職看得到別人的
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
        waiting: q.length,
        longest_min: q.length ? q[0].wait_min : 0,
      };
    });
  }

  // 事件流：訊息與指派合併成一條時間軸。指派事件是這頁跟收件匣的差別 ——
  // 老闆要看得到「誰把誰的對話轉給誰」，那是管理動作不是聊天內容。
  const msgs = await db.all(
    `SELECT m.created_at AS at, m.direction, m.text, u.name AS who,
            ct.display_name AS contact
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE 1=1${mine}
      ORDER BY m.id DESC LIMIT 14`);
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

  return {
    now: nowIso,
    can_see_all: all,
    stats: {
      waiting: waiting.length,
      unassigned: waiting.filter((w) => !w.assigned_to).length,
      longest_min: longest,
      over_warn: waiting.filter((w) => w.wait_min >= WAIT_WARN).length,
      incoming_24h: flow.incoming || 0,
      outgoing_24h: flow.outgoing || 0,
    },
    thresholds: { warn: WAIT_WARN, bad: WAIT_BAD },
    waiting: waiting.slice(0, 30),
    load,
    events,
  };
}
