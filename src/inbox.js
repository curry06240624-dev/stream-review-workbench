/**
 * 訊息中心 —— Super 8 的核心，也是這套系統最需要做對的地方。
 *
 * 權限模型（照瑋瑋 8/26 電話裡描述的實際運作）：
 *   運營（operator）／老闆（admin）：看得到全部，可以指派
 *   訊息手（agent）：**只看得到指派給自己的對話**，同層級互相看不到
 *
 * ⚠️ 權限一律在伺服器端算，前端只是畫面。
 *    「前端不顯示」不是權限 —— 直接打 API 就繞過去了。
 *    這裡每一個查詢都帶 assigned_to 條件，不是查完再過濾。
 */

export const canSeeAll = (role) => role === "admin" || role === "operator";

/** 收件匣清單。agent 只拿得到自己的，這是 SQL 層擋的不是畫面層。 */
export async function listConversations(db, me, box) {
  const base = `
    SELECT c.id, c.channel, c.status, c.assigned_to, c.unread, c.last_message_at,
           ct.display_name, ct.phone, ct.grade,
           u.name AS agent_name,
           (SELECT m.text FROM messages m WHERE m.conversation_id = c.id
             ORDER BY m.id DESC LIMIT 1) AS last_text,
           (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id
             ORDER BY m.id DESC LIMIT 1) AS last_dir
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN users u ON u.id = c.assigned_to`;

  if (!canSeeAll(me.role)) {
    // 訊息手：永遠只有自己的，box 參數影響不了這一條
    return db.all(base + ` WHERE c.assigned_to = ? ORDER BY c.last_message_at DESC LIMIT 200`, me.id);
  }
  if (box === "unassigned") {
    return db.all(base + ` WHERE c.assigned_to IS NULL ORDER BY c.last_message_at DESC LIMIT 200`);
  }
  if (box === "mine") {
    return db.all(base + ` WHERE c.assigned_to = ? ORDER BY c.last_message_at DESC LIMIT 200`, me.id);
  }
  return db.all(base + ` ORDER BY c.last_message_at DESC LIMIT 200`);
}

/** 單一對話。看不到就回 null —— 呼叫端一律回 404，不回 403：
 *  403 等於告訴對方「這個對話存在，只是不給你看」，那本身就是洩漏。 */
export async function getConversation(db, me, id) {
  const c = await db.first(
    `SELECT c.*, ct.display_name, ct.phone, ct.grade, ct.note, u.name AS agent_name
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN users u ON u.id = c.assigned_to
      WHERE c.id = ?`, id);
  if (!c) return null;
  if (!canSeeAll(me.role) && c.assigned_to !== me.id) return null;

  const messages = await db.all(
    `SELECT m.id, m.direction, m.text, m.created_at, u.name AS sender_name
       FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE m.conversation_id = ? ORDER BY m.id`, id);
  const channels = await db.all(
    "SELECT channel, channel_uid, source FROM contact_channels WHERE contact_id = ?", c.contact_id);
  return { conversation: c, messages, channels };
}

/** 指派。只有運營／老闆能做。 */
export async function assign(db, me, convId, toUserId, now) {
  if (!canSeeAll(me.role)) return { error: "forbidden", message: "只有運營或管理者可以指派。" };
  const c = await db.first("SELECT id, assigned_to FROM conversations WHERE id = ?", convId);
  if (!c) return { error: "not_found", message: "找不到這個對話。" };

  if (toUserId !== null) {
    const u = await db.first("SELECT id FROM users WHERE id = ?", toUserId);
    if (!u) return { error: "bad_user", message: "找不到這個成員。" };
  }
  await db.run("UPDATE conversations SET assigned_to = ? WHERE id = ?", toUserId, convId);
  await db.run(
    `INSERT INTO assignment_log (conversation_id, from_user_id, to_user_id, by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    convId, c.assigned_to, toUserId, me.id, now);
  return { ok: true };
}

/** 回覆。訊息手只能回自己被指派的那些。
 *  這裡**只寫進自己的資料庫**，第一階段不碰 LINE API（瑋瑋的紅線）。 */
export async function reply(db, me, convId, text, now) {
  const c = await db.first("SELECT id, assigned_to FROM conversations WHERE id = ?", convId);
  if (!c) return { error: "not_found", message: "找不到這個對話。" };
  if (!canSeeAll(me.role) && c.assigned_to !== me.id) {
    return { error: "not_found", message: "找不到這個對話。" };
  }
  const body = String(text || "").trim();
  if (!body) return { error: "empty", message: "訊息不能是空的。" };
  if (body.length > 2000) return { error: "too_long", message: "訊息太長了（上限 2000 字）。" };

  await db.run(
    `INSERT INTO messages (conversation_id, direction, sender_user_id, text, created_at)
     VALUES (?, 'out', ?, ?, ?)`, convId, me.id, body, now);
  await db.run("UPDATE conversations SET last_message_at = ?, unread = 0 WHERE id = ?", now, convId);
  return { ok: true };
}

/** 收件匣統計，給側邊欄的數字用。agent 看到的是自己的數字。 */
export async function inboxCounts(db, me) {
  if (!canSeeAll(me.role)) {
    const mine = await db.first(
      "SELECT COUNT(*) AS c FROM conversations WHERE assigned_to = ? AND status='open'", me.id);
    return { all: mine.c, unassigned: 0, mine: mine.c };
  }
  const all = await db.first("SELECT COUNT(*) AS c FROM conversations WHERE status='open'");
  const un = await db.first(
    "SELECT COUNT(*) AS c FROM conversations WHERE assigned_to IS NULL AND status='open'");
  const mine = await db.first(
    "SELECT COUNT(*) AS c FROM conversations WHERE assigned_to = ? AND status='open'", me.id);
  return { all: all.c, unassigned: un.c, mine: mine.c };
}
