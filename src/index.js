/**
 * 路由。靜態頁面由 [assets] 服務（public/），這裡只管 /api/*。
 *
 * 紅線（照瑋瑋提案，全期有效）：本系統不碰 LINE API、不做訊息收發、
 * 不接任何正式系統；第一階段只吃假資料。
 */
import { AppDB } from "./db.js";
import { currentUser, createUser, issueSession, login, setCookie, cookieOf } from "./auth.js";
import { listConversations, getConversation, assign, reply, inboxCounts, canSeeAll } from "./inbox.js";

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

  /* ── Demo 一鍵登入：只在 DEMO_MODE=on 時存在，而且只認這四個假帳號。
       用途是 demo 時不用當著客戶的面打帳號密碼。
       正式環境不要設這個變數，這個端點就會直接消失（回 404，跟沒寫過一樣）。
       注意：它繞過的是「證明你是誰」，不是「你能看到什麼」——
       登入後的權限一律照 role 走，跟正常登入完全同一條路。 ── */
  if (p === "/api/demo-login" && m === "POST") {
    if (env.DEMO_MODE !== "on") return J({ ok: false, error: "not_found" }, 404);
    const b = await request.json().catch(() => ({}));
    const ALLOWED = ["boss@test.local", "operator@test.local", "agent1@test.local", "agent2@test.local"];
    const email = String(b.email || "").trim().toLowerCase();
    if (!ALLOWED.includes(email)) return J({ ok: false, error: "not_demo_account" }, 403);
    const u = await db.first("SELECT * FROM users WHERE email = ?", email);
    if (!u) return J({ ok: false, error: "no_user", message: "示範帳號還沒建立。" }, 404);
    const s = await issueSession(db, u.id);
    return J({ ok: true, user: { email: u.email, name: u.name, role: u.role } }, 200,
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
    return J({ ok: true, user: u ? { email: u.email, name: u.name, role: u.role } : null, needsSetup: n.c === 0, demo: env.DEMO_MODE === "on" });
  }

  /* ── 以下全部要登入 ── */
  const me = await currentUser(request, db);
  if (!me) return J({ ok: false, error: "not_logged_in", message: "請先登入。" }, 401);

  /* ── 假資料寫入。只有 admin，而且只在對話數為 0 時能跑 ——
       這是開發用的種子，不是給正式資料用的匯入端點。 ── */
  if (p === "/api/seed-inbox" && m === "POST") {
    if (me.role !== "admin") return J({ ok: false, error: "forbidden" }, 403);
    const n = await db.first("SELECT COUNT(*) AS c FROM conversations");
    if (n.c > 0) return J({ ok: false, error: "not_empty", message: `已經有 ${n.c} 個對話了，不重複寫入。` }, 409);
    const b = await request.json().catch(() => ({}));
    let nc = 0, nv = 0, nm = 0;
    for (const c of b.contacts || []) {
      const ct = await db.run(
        "INSERT INTO contacts (display_name, phone, grade, created_at) VALUES (?, ?, ?, ?)",
        String(c.display_name).slice(0, 40), String(c.phone || "").slice(0, 30),
        ["S", "A", "B", "C"].includes(c.grade) ? c.grade : "C", now());
      nc++;
      await db.run(
        "INSERT INTO contact_channels (contact_id, channel, channel_uid, source) VALUES (?, 'line', ?, ?)",
        ct.lastRowId, String(c.channel_uid), String(c.source || ""));
      const msgs = c.messages || [];
      const last = msgs.length ? msgs[msgs.length - 1].created_at : now();
      const cv = await db.run(
        `INSERT INTO conversations (contact_id, channel, assigned_to, last_message_at, unread, created_at)
         VALUES (?, 'line', ?, ?, ?, ?)`,
        ct.lastRowId, c.assigned_to ?? null, last,
        msgs.length && msgs[msgs.length - 1].direction === "in" ? 1 : 0, now());
      nv++;
      for (const msg of msgs) {
        await db.run(
          `INSERT INTO messages (conversation_id, direction, sender_user_id, text, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          cv.lastRowId, msg.direction === "out" ? "out" : "in",
          msg.sender_user_id ?? null, String(msg.text).slice(0, 2000), msg.created_at || now());
        nm++;
      }
    }
    return J({ ok: true, contacts: nc, conversations: nv, messages: nm });
  }

  /* ── 成員管理：只有 admin 能開帳號（運營／訊息手） ── */
  if (p === "/api/members" && m === "GET") {
    if (me.role !== "admin") return J({ ok: false, error: "forbidden" }, 403);
    const rows = await db.all(
      `SELECT u.id, u.email, u.name, u.role, u.created_at,
              (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to = u.id) AS conv_count
         FROM users u ORDER BY u.id`);
    return J({ ok: true, members: rows });
  }
  if (p === "/api/members" && m === "POST") {
    if (me.role !== "admin") return J({ ok: false, error: "forbidden", message: "只有管理者可以新增成員。" }, 403);
    const b = await request.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    const name = String(b.name || "").trim();
    const role = ["operator", "agent"].includes(b.role) ? b.role : "agent";
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return J({ ok: false, error: "bad_email", message: "信箱格式不對。" }, 400);
    if (password.length < 8) return J({ ok: false, error: "weak", message: "密碼至少 8 個字。" }, 400);
    if (!name) return J({ ok: false, error: "no_name", message: "要填名字。" }, 400);
    if (await db.first("SELECT id FROM users WHERE email = ?", email)) {
      return J({ ok: false, error: "taken", message: "這個信箱已經有帳號了。" }, 409);
    }
    const id = await createUser(db, { email, name, password, role });
    return J({ ok: true, id });
  }

  /* ══ 訊息中心 ══ 權限全部在伺服器端算，見 inbox.js 的說明 ══ */
  if (p === "/api/inbox" && m === "GET") {
    const box = url.searchParams.get("box") || "all";
    const [conversations, counts] = await Promise.all([
      listConversations(db, me, box), inboxCounts(db, me),
    ]);
    let agents = [];
    if (canSeeAll(me.role)) {
      agents = await db.all("SELECT id, name, role FROM users WHERE role='agent' ORDER BY name");
    }
    return J({ ok: true, conversations, counts, agents, me: { id: me.id, role: me.role, name: me.name } });
  }

  const mConv = p.match(/^\/api\/conversations\/(\d+)$/);
  if (mConv && m === "GET") {
    const data = await getConversation(db, me, Number(mConv[1]));
    // 看不到就是 404 —— 回 403 等於承認「這個對話存在」，那本身就是洩漏
    if (!data) return J({ ok: false, error: "not_found", message: "找不到這個對話。" }, 404);
    return J({ ok: true, ...data });
  }

  const mAssign = p.match(/^\/api\/conversations\/(\d+)\/assign$/);
  if (mAssign && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const to = b.to_user_id === null || b.to_user_id === "" ? null : Number(b.to_user_id);
    const r = await assign(db, me, Number(mAssign[1]), to, now());
    if (r.error) return J({ ok: false, ...r }, r.error === "forbidden" ? 403 : 404);
    return J({ ok: true });
  }

  const mReply = p.match(/^\/api\/conversations\/(\d+)\/reply$/);
  if (mReply && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const r = await reply(db, me, Number(mReply[1]), b.text, now());
    if (r.error) return J({ ok: false, ...r }, r.error === "not_found" ? 404 : 400);
    return J({ ok: true });
  }

  /* ── 總覽：全部是真算出來的數字，沒有裝飾用的假儀表。
       agent 看到的是自己的範圍，跟收件匣同一套權限。 ── */
  if (p === "/api/dashboard" && m === "GET") {
    const all = canSeeAll(me.role);
    const scope = all ? "" : " AND c.assigned_to = " + Number(me.id);

    const t = await db.first(`SELECT
        COUNT(*) AS conversations,
        SUM(CASE WHEN c.assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned,
        SUM(c.unread) AS unread
      FROM conversations c WHERE c.status='open'` + scope);
    const msgs = await db.first(
      `SELECT COUNT(*) AS n FROM messages mm
        JOIN conversations c ON c.id = mm.conversation_id WHERE 1=1` + scope);
    const grades = await db.all(
      `SELECT ct.grade, COUNT(*) AS n FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id WHERE 1=1` + scope + ` GROUP BY ct.grade`);
    const sources = await db.all(
      `SELECT cc.source, COUNT(*) AS n FROM conversations c
         JOIN contact_channels cc ON cc.contact_id = c.contact_id
        WHERE cc.source <> ''` + scope + ` GROUP BY cc.source ORDER BY n DESC`);

    // 訊息手戰況：只有管理職看得到別人的數字
    let agents = [];
    if (all) {
      agents = await db.all(
        `SELECT u.id, u.name, u.role,
                (SELECT COUNT(*) FROM conversations c
                  WHERE c.assigned_to = u.id AND c.status='open') AS assigned,
                (SELECT COALESCE(SUM(c.unread),0) FROM conversations c
                  WHERE c.assigned_to = u.id AND c.status='open') AS unread,
                (SELECT COUNT(*) FROM messages mm
                  WHERE mm.sender_user_id = u.id) AS replies
           FROM users u WHERE u.role IN ('agent','operator') ORDER BY assigned DESC, u.name`);
    }
    const recent = await listConversations(db, me, "all");

    const g = { S: 0, A: 0, B: 0, C: 0 };
    for (const r of grades) if (g[r.grade] !== undefined) g[r.grade] = r.n;
    return J({ ok: true,
      totals: { conversations: t.conversations || 0, unassigned: t.unassigned || 0,
                unread: t.unread || 0, messages: msgs.n || 0 },
      grades: g, sources, agents, recent: recent.slice(0, 8), can_see_all: all });
  }

  return J({ ok: false, error: "not_found", message: "沒有這個 API。" }, 404);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}
