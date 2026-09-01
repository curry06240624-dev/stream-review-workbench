/**
 * 路由。靜態頁面由 [assets] 服務（public/），這裡只管 /api/*。
 *
 * 紅線（照瑋瑋提案，全期有效）：本系統不碰 LINE API、不做訊息收發、
 * 不接任何正式系統；第一階段只吃假資料。
 */
import { AppDB } from "./db.js";
import { currentUser, createUser, issueSession, login, setCookie, cookieOf } from "./auth.js";
import { listConversations, getConversation, assign, reply, inboxCounts, canSeeAll } from "./inbox.js";
import { listContacts, getContact, updateContact } from "./contacts.js";
import { situation, getSla } from "./situation.js";
import { listRules, matchRule, tryAutoReply, blockedReason } from "./autoreply.js";

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
    const b = await request.json().catch(() => ({}));
    const n = await db.first("SELECT COUNT(*) AS c FROM conversations");
    if (n.c > 0 && !b.reset) {
      return J({ ok: false, error: "not_empty",
                 message: `已經有 ${n.c} 個對話了。要重灌請帶 reset:true。` }, 409);
    }
    if (b.reset) {
      // 只清假資料相關的表 —— 使用者帳號與設定保留，不然重灌一次就要重建帳號
      for (const t of ["assignment_log", "messages", "conversations",
                       "contact_channels", "contacts"]) {
        await db.run("DELETE FROM " + t);
      }
    }
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

  /* ══ 營運設定 ══ 讀給所有登入者（畫面要顯示目標），只有 admin 能改 ══ */
  if (p === "/api/settings" && m === "GET") {
    const rows = await db.all("SELECT key, value FROM settings");
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return J({ ok: true, settings: out, can_edit: me.role === "admin" });
  }
  if (p === "/api/settings" && m === "PATCH") {
    if (me.role !== "admin") {
      return J({ ok: false, error: "forbidden", message: "只有管理者可以改營運設定。" }, 403);
    }
    const b = await request.json().catch(() => ({}));
    if (b.sla_minutes !== undefined) {
      const n = Number(b.sla_minutes);
      if (!Number.isFinite(n) || n < 1 || n > 1440) {
        return J({ ok: false, error: "bad_sla", message: "SLA 目標要介於 1 到 1440 分鐘。" }, 400);
      }
      await db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES ('sla_minutes', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        String(Math.round(n)), now());
    }
    return J({ ok: true, sla_minutes: await getSla(db) });
  }

  /* ══ 自動回覆 ══ 規則由運營/管理者維護，訊息手唯讀 ══ */
  if (p === "/api/autoreplies" && m === "GET") {
    return J({ ok: true, rules: await listRules(db), can_edit: canSeeAll(me.role) });
  }
  if (p === "/api/autoreplies" && m === "POST") {
    if (!canSeeAll(me.role)) return J({ ok: false, error: "forbidden", message: "只有運營或管理者可以改規則。" }, 403);
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || "").trim().slice(0, 40);
    const keywords = String(b.keywords || "").trim().slice(0, 300);
    const reply = String(b.reply || "").trim().slice(0, 900);
    if (!name || !keywords || !reply) {
      return J({ ok: false, error: "incomplete", message: "名稱、關鍵字、回覆內容都要填。" }, 400);
    }
    const r = await db.run(
      `INSERT INTO autoreplies (name, keywords, reply, enabled, created_at)
       VALUES (?, ?, ?, 1, ?)`, name, keywords, reply, now());
    return J({ ok: true, id: r.lastRowId });
  }
  const mAr = p.match(/^\/api\/autoreplies\/(\d+)$/);
  if (mAr && (m === "PATCH" || m === "DELETE")) {
    if (!canSeeAll(me.role)) return J({ ok: false, error: "forbidden", message: "只有運營或管理者可以改規則。" }, 403);
    const id = Number(mAr[1]);
    if (m === "DELETE") {
      await db.run("DELETE FROM autoreply_log WHERE rule_id = ?", id);
      await db.run("DELETE FROM autoreplies WHERE id = ?", id);
      return J({ ok: true });
    }
    const b = await request.json().catch(() => ({}));
    if (b.enabled !== undefined) {
      await db.run("UPDATE autoreplies SET enabled = ?, updated_at = ? WHERE id = ?",
        b.enabled ? 1 : 0, now(), id);
    }
    for (const f of ["name", "keywords", "reply"]) {
      if (b[f] !== undefined) {
        await db.run(`UPDATE autoreplies SET ${f} = ?, updated_at = ? WHERE id = ?`,
          String(b[f]).slice(0, 900), now(), id);
      }
    }
    return J({ ok: true });
  }

  /* 規則測試器：貼一句話，看會命中哪條、會回什麼。
     沒有這個，運營只能把規則開下去然後祈禱 —— 那不是可維護的系統。 */
  if (p === "/api/autoreplies/test" && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const hit = matchRule(await listRules(db), String(b.text || ""));
    return J({ ok: true, matched: hit ? { id: hit.rule.id, name: hit.rule.name,
      keyword: hit.keyword, reply: hit.rule.reply } : null });
  }

  /* 模擬客人來訊：第一階段不接 LINE，這是唯一能端到端驗證自動回覆的方式。
     只有 admin 能用，而且只能對已存在的假對話下手。 */
  if (p === "/api/simulate-incoming" && m === "POST") {
    if (me.role !== "admin") return J({ ok: false, error: "forbidden" }, 403);
    const b = await request.json().catch(() => ({}));
    const convId = Number(b.conversation_id);
    const text = String(b.text || "").trim().slice(0, 900);
    if (!convId || !text) return J({ ok: false, error: "bad_input", message: "要指定對話與內容。" }, 400);
    const conv = await db.first("SELECT id FROM conversations WHERE id = ?", convId);
    if (!conv) return J({ ok: false, error: "not_found" }, 404);
    const at = now();
    await db.run(
      `INSERT INTO messages (conversation_id, direction, sender_user_id, text, created_at)
       VALUES (?, 'in', NULL, ?, ?)`, convId, text, at);
    await db.run("UPDATE conversations SET last_message_at = ?, unread = unread + 1 WHERE id = ?", at, convId);
    const auto = await tryAutoReply(db, convId, text, new Date(Date.parse(at) + 1000).toISOString());
    return J({ ok: true, auto });
  }

  /* ══ 現場狀況 ══ 指揮中心主畫面，依等待時間排序 ══ */
  if (p === "/api/situation" && m === "GET") {
    return J({ ok: true, ...(await situation(db, me, now())) });
  }

  /* ══ 客戶中心 ══ 權限同訊息中心：訊息手只看得到自己跟進的客戶 ══ */
  if (p === "/api/contacts" && m === "GET") {
    const contacts = await listContacts(db, me, {
      q: url.searchParams.get("q") || "",
      grade: url.searchParams.get("grade") || "",
    });
    return J({ ok: true, contacts, can_see_all: canSeeAll(me.role) });
  }

  /* 匯出 CSV —— 對照 Super 8 的「匯出客戶資料」。
     只有管理職能匯出：訊息手能匯出等於整份客戶名單可以被帶走。 */
  if (p === "/api/contacts.csv" && m === "GET") {
    if (!canSeeAll(me.role)) {
      return J({ ok: false, error: "forbidden", message: "只有運營或管理者可以匯出客戶資料。" }, 403);
    }
    const rows = await listContacts(db, me, { limit: 500 });
    /* 不用跳脫序列建字元 —— 這段程式碼經過多層工具轉手，字串裡寫
       backslash-n 會在某一層變成真的換行，把 regex 或字串截斷（踩過兩次）。 */
    const NL = String.fromCharCode(10), CRLF = String.fromCharCode(13, 10);
    const BOM = String.fromCharCode(65279);   // Excel 開 UTF-8 中文要靠這個才不亂碼
    const esc = (v) => {
      const t = String(v ?? '');
      return (t.includes(',') || t.includes(String.fromCharCode(34)) || t.includes(NL))
        ? String.fromCharCode(34) + t.split(String.fromCharCode(34)).join(String.fromCharCode(34,34)) + String.fromCharCode(34)
        : t;
    };
    const head = ['客戶名稱','電話','分級','渠道','獲客來源','對話數','最後往來','負責人','備註'];
    const body = rows.map((r) => [r.display_name, r.phone, r.grade, r.channel || '', r.source || '',
      r.conv_count, (r.last_at || '').slice(0, 10), r.agent_name || '', r.note || ''].map(esc).join(','));
    return new Response(BOM + [head.join(','), ...body].join(CRLF), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="contacts.csv"',
        "cache-control": "no-store",
      },
    });
  }

  const mCt = p.match(/^\/api\/contacts\/(\d+)$/);
  if (mCt && m === "GET") {
    const data = await getContact(db, me, Number(mCt[1]));
    if (!data) return J({ ok: false, error: "not_found" }, 404);
    return J({ ok: true, ...data });
  }
  if (mCt && m === "PATCH") {
    const b = await request.json().catch(() => ({}));
    const r = await updateContact(db, me, Number(mCt[1]), b, now());
    if (!r) return J({ ok: false, error: "not_found" }, 404);
    if (r.error) return J({ ok: false, ...r }, 400);
    return J({ ok: true });
  }

  return J({ ok: false, error: "not_found", message: "沒有這個 API。" }, 404);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}
