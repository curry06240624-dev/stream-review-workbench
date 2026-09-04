/**
 * LINE Messaging API —— 收訊與發訊。
 *
 * ⚠️ 這個檔案有能力接上正式的官方帳號，但**接上是人的動作不是程式的動作**：
 *    LINE 一個官方帳號只能設定一組 webhook URL。把 URL 指到這裡的那一秒，
 *    Super 8 就收不到任何訊息，11 位客服會同時失去工具。
 *    那個按鈕永遠由 Curry 和瑋瑋自己按，不在任何自動流程裡。
 *
 * 三個查證過的硬約束（決定了下面的寫法）：
 *   1. 簽章要用**原始 bytes** 驗，不能先 JSON.parse 再重新序列化 —— 欄位順序或
 *      空白只要差一個字元，HMAC 就對不起來。
 *   2. replyToken 只能用一次、大約一分鐘就過期。過期或重複用會回 400。
 *      所以「回覆」與「主動推送」是兩條不同的路，不能混用。
 *   3. reply 不計入訊息量額度，push 會計。同一件事能用 reply 就不要用 push。
 */

const API = "https://api.line.me/v2/bot";
const enc = new TextEncoder();

/* ── 簽章驗證 ────────────────────────────────────────────── */

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;                      // 等時比對，不要用 === 比字串
}

/**
 * 驗 X-Line-Signature。
 * @param rawBody 原始請求 body 的字串（**不能**是 parse 過又 stringify 回來的）
 */
export async function verifySignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(channelSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const mine = new Uint8Array(mac);
  let theirs;
  try {
    theirs = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;                          // 對方給的不是合法 base64
  }
  return sameBytes(mine, theirs);
}

/* ── 對外呼叫 ────────────────────────────────────────────── */

async function callLine(path, token, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true };
  const detail = await r.text().catch(() => "");
  return { ok: false, status: r.status, detail: detail.slice(0, 400) };
}

/** 回覆（免費、但 replyToken 一分鐘內只能用一次） */
export const replyToLine = (token, replyToken, texts) =>
  callLine("/message/reply", token,
    { replyToken, messages: texts.map((t) => ({ type: "text", text: t })) });

/** 主動推送（會計入額度，只在沒有 replyToken 可用時才走這條） */
export const pushToLine = (token, to, texts) =>
  callLine("/message/push", token,
    { to, messages: texts.map((t) => ({ type: "text", text: t })) });

/** 抓使用者暱稱與頭像。抓不到不算錯 —— 對方封鎖後這支就會失敗。 */
export async function getProfile(token, userId) {
  try {
    const r = await fetch(`${API}/profile/${userId}`,
      { headers: { authorization: "Bearer " + token } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/* ── 事件正規化 ──────────────────────────────────────────── */

/** 非文字訊息在收件匣裡要有人看得懂的佔位字串 */
const PLACEHOLDER = {
  image: "［圖片］", video: "［影片］", audio: "［語音］", file: "［檔案］",
  location: "［位置］", sticker: "［貼圖］",
};

/**
 * 把一則 LINE event 攤平成我們要存的欄位。
 * 認不出來的型別不丟掉 —— 存成 unknown 保留原始 JSON，之後才有機會補處理。
 */
export function normalize(ev) {
  const base = {
    event_id: ev.webhookEventId || "",
    type: ev.type,
    channel_uid: ev.source?.userId || "",
    source_type: ev.source?.type || "",         // user | group | room
    group_id: ev.source?.groupId || ev.source?.roomId || "",
    reply_token: ev.replyToken || "",
    at: ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString(),
  };
  if (ev.type === "message") {
    const m = ev.message || {};
    return {
      ...base,
      msg_type: m.type || "unknown",
      channel_msg_id: m.id || "",
      text: m.type === "text" ? String(m.text ?? "") : (PLACEHOLDER[m.type] || "［不支援的訊息］"),
    };
  }
  return { ...base, msg_type: "", channel_msg_id: "", text: "" };
}
