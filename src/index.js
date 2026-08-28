/**
 * 路由。靜態頁面由 [assets] 服務（public/），這裡只管 /api/*。
 *
 * 紅線（照瑋瑋提案，全期有效）：本系統不碰 LINE API、不做訊息收發、
 * 不接任何正式系統；第一階段只吃假資料。
 */
import { AppDB } from "./db.js";
import { currentUser, createUser, issueSession, login, setCookie, cookieOf } from "./auth.js";
import { runReview } from "./gemini.js";

export { AppDB };

const J = (o, s = 200, headers = {}) => new Response(JSON.stringify(o), {
  status: s,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});
const now = () => new Date().toISOString();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });   // 靜態檔已由 assets 先接走
    }
    const db = env.APPDB.get(env.APPDB.idFromName("main"));

    try {
      return await route(request, env, db, url);
    } catch (e) {
      // 錯誤要讓人看得懂，但不要把堆疊丟到瀏覽器
      console.error(e);
      return J({ ok: false, error: "server", message: String(e.message || e).slice(0, 300) }, 500);
    }
  },
};

async function route(request, env, db, url) {
  const p = url.pathname;
  const m = request.method;

  if (p === "/api/health") return J({ ok: true, at: now() });

  /* ── 初始化：只在完全沒有使用者時可用，且要 SETUP_CODE ── */
  if (p === "/api/setup" && m === "POST") {
    const n = await db.first("SELECT COUNT(*) AS c FROM users");
    if (n.c > 0) return J({ ok: false, error: "done", message: "系統已初始化過了。" }, 409);
    const b = await request.json().catch(() => ({}));
    if (!env.SETUP_CODE || b.code !== env.SETUP_CODE) {
      return J({ ok: false, error: "bad_code", message: "初始化代碼不對。" }, 403);
    }
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    const name = String(b.name || "").trim() || email.split("@")[0];
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return J({ ok: false, error: "bad_email", message: "信箱格式不對。" }, 400);
    if (password.length < 8) return J({ ok: false, error: "weak", message: "密碼至少 8 個字。" }, 400);
    const uid = await createUser(db, { email, name, password, role: "admin" });
    const s = await issueSession(db, uid);
    return J({ ok: true, user: { email, name, role: "admin" } }, 200,
      { "set-cookie": setCookie(request, s.token, s.maxAge) });
  }

  if (p === "/api/login" && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const r = await login(db, String(b.email || "").trim().toLowerCase(), String(b.password || ""));
    if (r.error) return J({ ok: false, ...r }, r.error === "locked" ? 429 : 401);
    const s = await issueSession(db, r.user.id);
    return J({ ok: true, user: { email: r.user.email, name: r.user.name, role: r.user.role } }, 200,
      { "set-cookie": setCookie(request, s.token, s.maxAge) });
  }

  if (p === "/api/logout" && m === "POST") {
    const t = cookieOf(request);
    if (t) await db.run("DELETE FROM sessions WHERE token = ?", t);
    return J({ ok: true }, 200, { "set-cookie": setCookie(request, "", 0) });
  }

  if (p === "/api/me") {
    const u = await currentUser(request, db);
    const n = await db.first("SELECT COUNT(*) AS c FROM users");
    return J({ ok: true, user: u ? { email: u.email, name: u.name, role: u.role } : null, needsSetup: n.c === 0 });
  }

  /* ── 以下全部要登入 ── */
  const me = await currentUser(request, db);
  if (!me) return J({ ok: false, error: "not_logged_in", message: "請先登入。" }, 401);

  if (p === "/api/livestreams" && m === "GET") {
    const rows = await db.all(
      `SELECT l.id, l.live_date, l.metrics_json, s.name AS streamer,
              (SELECT r.id FROM reviews r WHERE r.livestream_id = l.id ORDER BY r.id DESC LIMIT 1) AS review_id
         FROM livestreams l JOIN streamers s ON s.id = l.streamer_id
        ORDER BY l.live_date DESC, l.id DESC LIMIT 100`);
    return J({ ok: true, livestreams: rows });
  }

  if (p === "/api/livestreams" && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const streamer = String(b.streamer || "").trim().slice(0, 40);
    const liveDate = String(b.live_date || "").slice(0, 10);
    const transcript = String(b.transcript || "");
    const metrics = {
      viewers_total: num(b.metrics?.viewers_total),
      peak_viewers: num(b.metrics?.peak_viewers),
      comments: num(b.metrics?.comments),
      inquiries: num(b.metrics?.inquiries),
    };
    if (!streamer) return J({ ok: false, error: "no_streamer", message: "要填直播主名稱。" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(liveDate)) return J({ ok: false, error: "bad_date", message: "日期格式要 YYYY-MM-DD。" }, 400);
    if (transcript.length < 200) return J({ ok: false, error: "short", message: "逐字稿太短（至少 200 字），AI 覆盤不出東西。" }, 400);
    if (transcript.length > 400000) return J({ ok: false, error: "long", message: "逐字稿太長，先拆場。" }, 400);

    await db.run("INSERT INTO streamers (name) VALUES (?) ON CONFLICT(name) DO NOTHING", streamer);
    const st = await db.first("SELECT id FROM streamers WHERE name = ?", streamer);
    const ls = await db.run(
      `INSERT INTO livestreams (streamer_id, live_date, metrics_json, transcript, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      st.id, liveDate, JSON.stringify(metrics), transcript, me.id, now());

    // AI 覆盤。失敗也要留紀錄（status=failed），不要讓這場直播消失在列表上
    let review;
    try {
      review = await runReview(env, { transcript, metrics });
    } catch (e) {
      const rid = await db.run(
        `INSERT INTO reviews (livestream_id, model, status, notes, created_at) VALUES (?, ?, 'failed', ?, ?)`,
        ls.lastRowId, env.GEMINI_MODEL || "?", String(e.message).slice(0, 300), now());
      return J({ ok: false, error: "ai_failed", livestream_id: ls.lastRowId, review_id: rid.lastRowId,
                 message: "直播已存檔，但 AI 覆盤失敗：" + String(e.message).slice(0, 160) }, 502);
    }
    const rv = await db.run(
      `INSERT INTO reviews (livestream_id, model, status, notes, created_at) VALUES (?, ?, 'done', ?, ?)`,
      ls.lastRowId, review.model, review.notes, now());
    for (const it of review.items) {
      await db.run(
        `INSERT INTO review_items (review_id, kind, seq, ai_text, quote, quote_pos, quote_ok, severity, success_criteria)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rv.lastRowId, it.kind, it.seq, it.ai_text, it.quote, it.quote_pos, it.quote_ok, it.severity, it.success_criteria);
    }
    return J({ ok: true, livestream_id: ls.lastRowId, review_id: rv.lastRowId });
  }

  const mR = p.match(/^\/api\/reviews\/(\d+)$/);
  if (mR && m === "GET") {
    const rv = await db.first(
      `SELECT r.*, l.live_date, l.metrics_json, s.name AS streamer
         FROM reviews r JOIN livestreams l ON l.id = r.livestream_id
                        JOIN streamers  s ON s.id = l.streamer_id
        WHERE r.id = ?`, Number(mR[1]));
    if (!rv) return J({ ok: false, error: "not_found" }, 404);
    const items = await db.all(
      "SELECT * FROM review_items WHERE review_id = ? ORDER BY kind DESC, seq", rv.id);
    return J({ ok: true, review: rv, items });
  }

  return J({ ok: false, error: "not_found", message: "沒有這個 API。" }, 404);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}
