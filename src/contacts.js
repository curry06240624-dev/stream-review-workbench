/**
 * 客戶中心 —— 對照 Super 8 的「客戶中心」（搜尋、分級、標記、匯出客戶資料）。
 *
 * 權限跟訊息中心同一條規則，而且是 SQL 層擋的：
 *   運營／老闆：全部客戶
 *   訊息手：**只看得到自己有在跟進的客戶**（有對話指派給他的那些）
 *
 * 為什麼訊息手不能看全部客戶名單：那等於整份客戶資料庫可以被任何一個
 * 訊息手匯出帶走。Super 8 的匯出功能是給管理職用的，這裡也一樣。
 */

import { canSeeAll } from "./inbox.js";

/** 訊息手只看得到自己有對話的客戶；管理職看全部。 */
function scopeSql(me) {
  if (canSeeAll(me.role)) return "";
  return ` AND EXISTS (SELECT 1 FROM conversations c
                        WHERE c.contact_id = ct.id AND c.assigned_to = ${Number(me.id)})`;
}

export async function listContacts(db, me, { q = "", grade = "", limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push("(ct.display_name LIKE ? OR ct.phone LIKE ? OR ct.note LIKE ?)");
    const like = "%" + q + "%";
    params.push(like, like, like);
  }
  if (["S", "A", "B", "C"].includes(grade)) {
    where.push("ct.grade = ?");
    params.push(grade);
  }
  const sql = `
    SELECT ct.id, ct.display_name, ct.phone, ct.grade, ct.note, ct.created_at,
           (SELECT cc.channel FROM contact_channels cc WHERE cc.contact_id = ct.id LIMIT 1) AS channel,
           (SELECT cc.source  FROM contact_channels cc WHERE cc.contact_id = ct.id LIMIT 1) AS source,
           (SELECT COUNT(*) FROM conversations c WHERE c.contact_id = ct.id) AS conv_count,
           (SELECT MAX(c.last_message_at) FROM conversations c WHERE c.contact_id = ct.id) AS last_at,
           (SELECT u.name FROM conversations c LEFT JOIN users u ON u.id = c.assigned_to
             WHERE c.contact_id = ct.id ORDER BY c.last_message_at DESC LIMIT 1) AS agent_name
      FROM contacts ct
     WHERE 1=1 ${where.length ? "AND " + where.join(" AND ") : ""} ${scopeSql(me)}
     ORDER BY last_at DESC NULLS LAST, ct.id DESC
     LIMIT ?`;
  return db.all(sql, ...params, Math.min(Number(limit) || 200, 500));
}

/** 單一客戶＋他的對話。看不到就回 null（呼叫端轉 404，不回 403）。 */
export async function getContact(db, me, id) {
  const ct = await db.first(
    `SELECT ct.* FROM contacts ct WHERE ct.id = ? ${scopeSql(me)}`, id);
  if (!ct) return null;
  const channels = await db.all(
    "SELECT channel, channel_uid, source FROM contact_channels WHERE contact_id = ?", id);
  const convs = await db.all(
    `SELECT c.id, c.status, c.unread, c.last_message_at, u.name AS agent_name,
            (SELECT m.text FROM messages m WHERE m.conversation_id = c.id
              ORDER BY m.id DESC LIMIT 1) AS last_text
       FROM conversations c LEFT JOIN users u ON u.id = c.assigned_to
      WHERE c.contact_id = ? ORDER BY c.last_message_at DESC`, id);
  const stat = await db.first(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN m.direction='in' THEN 1 ELSE 0 END) AS incoming
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.contact_id = ?`, id);
  return { contact: ct, channels, conversations: convs, stat };
}

/** 改分級／備註。訊息手只能改自己跟進的客戶（scopeSql 已擋）。 */
export async function updateContact(db, me, id, { grade, note }, now) {
  const ct = await db.first(`SELECT ct.id FROM contacts ct WHERE ct.id = ? ${scopeSql(me)}`, id);
  if (!ct) return null;
  if (grade !== undefined) {
    if (!["S", "A", "B", "C"].includes(grade)) return { error: "bad_grade", message: "分級只能是 S／A／B／C。" };
    await db.run("UPDATE contacts SET grade = ? WHERE id = ?", grade, id);
  }
  if (note !== undefined) {
    await db.run("UPDATE contacts SET note = ? WHERE id = ?", String(note).slice(0, 500), id);
  }
  return { ok: true };
}
