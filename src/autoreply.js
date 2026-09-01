/**
 * 自動回覆 —— 關鍵字規則。
 *
 * 為什麼先做這個：我們自己的假資料裡就有受害者 —— 等最久的佇列裡有一通是
 * 「你們營業到幾點」。這種問題不該佔用訊息手，也不該讓客人等兩小時。
 *
 * ⚠️ 自動回覆最容易做壞的地方不是「怎麼比對」，是「什麼時候不該回」。
 *    三道防線，缺一個就會出事：
 *
 *    ① 不插嘴：這通對話 10 分鐘內有真人回過 → 不自動回。
 *       真人正在跟客人談，機器人插一句罐頭話會毀掉那通生意。
 *    ② 不重複：同一條規則對同一通對話 24 小時內只回一次。
 *       客人連問三次「幾點」不該收到三次一樣的罐頭。
 *    ③ 不搶單：已指派且訊息手今天回過的對話 → 不自動回。
 *
 * 比對規則刻意做得笨且可解釋：去掉空白與標點後做子字串比對，
 * 由上而下第一條命中的規則獲勝。不做模糊比對、不做 AI 猜測 ——
 * 運營要能自己看規則就預測得到機器人會說什麼，猜不到的規則沒人敢開。
 */

const MIN = 60000;
export const NO_INTERRUPT_MIN = 10;      // 真人 10 分鐘內回過就不插嘴
export const REPEAT_WINDOW_H = 24;       // 同規則同對話 24 小時內不重複

/** 正規化：拿掉空白與常見標點，全形轉半形英數，統一小寫 */
export function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[，。、？！~…「」『』（）()？!?.,;:]/g, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 第一條命中的規則獲勝（依 id 由小到大）。回 null 代表沒命中。 */
export function matchRule(rules, text) {
  const t = norm(text);
  if (!t) return null;
  for (const r of rules) {
    if (!r.enabled) continue;
    const kws = String(r.keywords).split(",").map(norm).filter(Boolean);
    const hit = kws.find((k) => t.includes(k));
    if (hit) return { rule: r, keyword: hit };
  }
  return null;
}

export async function listRules(db) {
  return db.all("SELECT * FROM autoreplies ORDER BY id");
}

/** 這通對話現在可不可以自動回？回 null＝可以，回字串＝不行的理由。 */
export async function blockedReason(db, conversationId, ruleId, nowIso) {
  const now = Date.parse(nowIso);

  const lastOut = await db.first(
    `SELECT created_at, sender_user_id FROM messages
      WHERE conversation_id = ? AND direction = 'out'
      ORDER BY id DESC LIMIT 1`, conversationId);
  // ① 不插嘴：真人剛回過（sender_user_id 有值＝真人；機器人回的是 NULL）
  if (lastOut && lastOut.sender_user_id
      && now - Date.parse(lastOut.created_at) < NO_INTERRUPT_MIN * MIN) {
    return `真人在 ${NO_INTERRUPT_MIN} 分鐘內回過，不插嘴`;
  }
  // ② 不重複：同規則同對話 24 小時內只回一次
  const prev = await db.first(
    `SELECT created_at FROM autoreply_log
      WHERE conversation_id = ? AND rule_id = ?
      ORDER BY id DESC LIMIT 1`, conversationId, ruleId);
  if (prev && now - Date.parse(prev.created_at) < REPEAT_WINDOW_H * 60 * MIN) {
    return `同一條規則 ${REPEAT_WINDOW_H} 小時內已回過`;
  }
  return null;
}

/**
 * 有新的客人訊息進來時呼叫。回傳做了什麼，讓呼叫端可以顯示。
 * 注意：機器人回的訊息 sender_user_id 是 NULL —— 這樣畫面才分得出
 * 「這句是人講的」還是「這句是機器人講的」，稽核時很重要。
 */
export async function tryAutoReply(db, conversationId, text, nowIso) {
  const rules = await listRules(db);
  const m = matchRule(rules, text);
  if (!m) return { replied: false, reason: "沒有規則命中" };

  const blocked = await blockedReason(db, conversationId, m.rule.id, nowIso);
  if (blocked) return { replied: false, matched: m.rule.name, reason: blocked };

  await db.run(
    `INSERT INTO messages (conversation_id, direction, sender_user_id, text, created_at)
     VALUES (?, 'out', NULL, ?, ?)`, conversationId, m.rule.reply, nowIso);
  await db.run(
    `INSERT INTO autoreply_log (conversation_id, rule_id, matched_keyword, created_at)
     VALUES (?, ?, ?, ?)`, conversationId, m.rule.id, m.keyword, nowIso);
  await db.run("UPDATE autoreplies SET hits = hits + 1 WHERE id = ?", m.rule.id);
  await db.run(
    "UPDATE conversations SET last_message_at = ?, unread = 0 WHERE id = ?",
    nowIso, conversationId);

  return { replied: true, matched: m.rule.name, keyword: m.keyword, reply: m.rule.reply };
}

/** 現在等待中的對話，有幾通其實規則接得住 —— 把功能變成一個數字。 */
export async function coverageOfWaiting(db, waiting) {
  const rules = await listRules(db);
  let covered = 0;
  const samples = [];
  for (const w of waiting) {
    const m = matchRule(rules, w.last_text);
    if (m) {
      covered++;
      if (samples.length < 3) samples.push({ name: w.name, rule: m.rule.name });
    }
  }
  return { covered, samples };
}
