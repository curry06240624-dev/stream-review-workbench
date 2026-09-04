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
import { importBundle } from "./adapters/import.ts";
import { runFunnel } from "./engine/funnel.ts";
import { computeAnalytics } from "./engine/analytics.ts";
import { deriveInsights, persistInsights } from "./engine/insights.ts";
import { narrateInsights, generateBrief } from "./engine/ai.ts";
import { handleViews } from "./routes/views.ts";
import { answer as askAnswer } from "./engine/ask.ts";

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
      // 靜態檔已由 assets 先接走；走到這裡的是 SPA 路徑（/overview、/conversations/12 …）→ 回 index.html
      const wantsHtml = (request.headers.get("accept") || "").includes("text/html");
      if (request.method === "GET" && wantsHtml && env.ASSETS) {
        return env.ASSETS.fetch(new Request(new URL("/", request.url), request));   // 要 "/" 不要 "/index.html"：assets 會把後者 307 轉去 "/"
      }
      return new Response("Not found", { status: 404 });
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

  /* ── 匯入 NormalizedBundle（模擬器／Super 8 擷取／瑋瑋的表都走這裡）── */
  if (p === "/api/admin/import" && m === "POST") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in", message: "請先登入。" }, 401);
    if (me.role !== "admin") return J({ ok: false, message: "只有管理員可以匯入資料。" }, 403);
    const b = await request.json().catch(() => null);
    if (!b || !Array.isArray(b.conversations) || !b.source_system) {
      return J({ ok: false, message: "bundle 格式不對：要有 source_system 與 conversations。" }, 400);
    }
    const reset = url.searchParams.get("reset") === "1" || b.reset === true;
    const rep = await importBundle(db, b, { reset, now: now() });
    return J({ ok: true, ...rep });
  }

  /* ── 漏斗引擎：重算事件（冪等）／讀事件（含證據）── */
  if (p === "/api/admin/funnel/run" && m === "POST") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (me.role !== "admin") return J({ ok: false, error: "forbidden" }, 403);
    const b = await request.json().catch(() => ({}));
    const t0 = Date.now();
    const r = await runFunnel(db, { now: b.now || now(), leadIds: Array.isArray(b.lead_ids) ? b.lead_ids.map(Number) : undefined });
    return J({ ok: true, ...r, ms: Date.now() - t0 });
  }
  if (p === "/api/admin/funnel/events" && m === "GET") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (me.role !== "admin") return J({ ok: false, error: "forbidden" }, 403);
    const rows = await db.all(
      `SELECT e.id, e.lead_id, e.type, e.at, e.confidence, e.source, e.detail, cv.external_id AS conv_key,
              (SELECT COUNT(*) FROM evidence x WHERE x.event_id = e.id) AS evidence_n
         FROM funnel_events e LEFT JOIN conversations cv ON cv.id = e.conversation_id
        ORDER BY e.lead_id, e.at`);
    const stages = await db.all("SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage");
    return J({ ok: true, events: rows, stages });
  }

  /* ── 分析：決定性數字（本期 vs 前期）。管理職才看全公司；訊息手之後給個人版。── */
  if (p === "/api/analytics" && m === "GET") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (!canSeeAll(me.role)) return J({ ok: false, error: "forbidden" }, 403);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || 7)));
    const to = url.searchParams.get("to") || undefined;
    const t0 = Date.now();
    const a = await computeAnalytics(db, { to, days });
    return J({ ok: true, ms: Date.now() - t0, ...a });
  }

  /* ── 問 AI：規則判斷意圖 → 決定性分析 → AI 只講人話（事實包閘門），見 engine/ask.ts ── */
  if (p === "/api/ask" && m === "POST") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (!canSeeAll(me.role)) return J({ ok: false, message: "問 AI 目前只開放給老闆與主管。" }, 403);
    const b = await request.json().catch(() => ({}));
    const q = String(b.q || "").trim().slice(0, 200);
    if (!q) return J({ ok: false, message: "請輸入問題。" }, 400);
    const t0 = Date.now();
    const answer = await askAnswer(db, env, q);
    return J({ ok: true, ms: Date.now() - t0, answer });
  }

  /* ── 洞察：分析 → 規則推導 → 落庫（含證據）→ AI 敘事 → CEO 簡報 ── */
  if (p === "/api/insights/run" && m === "POST") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (!canSeeAll(me.role)) return J({ ok: false, error: "forbidden" }, 403);
    const b = await request.json().catch(() => ({}));
    const t0 = Date.now(), at = now();
    const a = await computeAnalytics(db, { to: b.to, days: Math.min(90, Math.max(1, Number(b.days || 7))) });
    const cands = deriveInsights(a);
    const { ids } = await persistInsights(db, cands, a, at);
    const nar = b.narrate === false ? { narrated: 0, mode: "skipped" } : await narrateInsights(db, env, a, at);
    const date = (b.to || at).slice(0, 10);
    const brief = b.brief === false ? null : await generateBrief(db, env, a, date, at);
    return J({ ok: true, ms: Date.now() - t0, candidates: cands.length, persisted: ids.length, narrate: nar, brief: brief ? { mode: brief.mode, model: brief.model, date } : null });
  }
  if (p === "/api/insights" && m === "GET") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (!canSeeAll(me.role)) return J({ ok: false, error: "forbidden" }, 403);
    const rows = await db.all(
      `SELECT i.*, (SELECT COUNT(*) FROM evidence x WHERE x.insight_id = i.id) AS evidence_n,
              (SELECT COUNT(DISTINCT x.lead_id) FROM evidence x WHERE x.insight_id = i.id) AS leads_n
         FROM insights i WHERE i.dismissed = 0
        ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.created_at DESC, i.id LIMIT 40`);
    const ids = rows.map((r) => r.id);
    const acts = ids.length ? await db.all(`SELECT * FROM actions WHERE insight_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids) : [];
    return J({ ok: true, insights: rows.map((r) => ({ ...r, metric: JSON.parse(r.metric || "{}"), actions: acts.filter((x) => x.insight_id === r.id) })) });
  }
  const mIns = p.match(/^\/api\/insights\/(\d+)\/evidence$/);
  if (mIns && m === "GET") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (!canSeeAll(me.role)) return J({ ok: false, error: "forbidden" }, 403);
    const id = Number(mIns[1]);
    const ins = await db.first("SELECT * FROM insights WHERE id = ?", id);
    if (!ins) return J({ ok: false, message: "找不到這條洞察。" }, 404);
    // 每個 lead 一組：客戶、業務、車、階段、結果、證據訊息＋前後各 2 則脈絡
    const ev = await db.all(`SELECT x.message_id, x.note, x.lead_id FROM evidence x WHERE x.insight_id = ? ORDER BY x.lead_id, x.id`, id);
    const byLead = new Map();
    for (const e of ev) { if (!byLead.has(e.lead_id)) byLead.set(e.lead_id, []); byLead.get(e.lead_id).push(e); }
    const groups = [];
    for (const [leadId, items] of byLead) {
      const lead = await db.first(
        `SELECT l.id, l.stage, l.outcome, l.opened_at, c.display_name AS contact, c.grade, COALESCE(u.name,'未指派') AS staff,
                COALESCE(v.brand || ' ' || v.model, '') AS vehicle, (SELECT id FROM conversations WHERE lead_id = l.id LIMIT 1) AS conversation_id
           FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = l.staff_id LEFT JOIN vehicles v ON v.id = l.vehicle_id WHERE l.id = ?`, leadId);
      const msgIds = items.map((x) => x.message_id).filter(Boolean);
      const qs = msgIds.map(() => "?").join(",");
      const msgs = msgIds.length ? await db.all(
        `SELECT m.id, m.sender_role, m.text, m.created_at, m.conversation_id FROM messages m
          WHERE m.conversation_id = ? AND m.id BETWEEN (SELECT MIN(id) FROM messages WHERE id IN (${qs})) - 2
                                        AND (SELECT MAX(id) FROM messages WHERE id IN (${qs})) + 2
          ORDER BY m.created_at, m.id`, lead ? lead.conversation_id : 0, ...msgIds, ...msgIds) : [];
      const notes = Object.fromEntries(items.map((x) => [x.message_id, x.note]));
      groups.push({ lead, messages: msgs.map((mm) => ({ ...mm, is_evidence: msgIds.includes(mm.id), note: notes[mm.id] || "" })) });
    }
    return J({ ok: true, insight: { ...ins, metric: JSON.parse(ins.metric || "{}") }, groups });
  }
  if (p === "/api/brief" && m === "GET") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (!canSeeAll(me.role)) return J({ ok: false, error: "forbidden" }, 403);
    const date = url.searchParams.get("date");
    const row = date ? await db.first("SELECT * FROM briefs WHERE brief_date = ?", date) : await db.first("SELECT * FROM briefs ORDER BY brief_date DESC LIMIT 1");
    if (!row) return J({ ok: true, brief: null });
    return J({ ok: true, brief: { ...row, content: JSON.parse(row.content) } });
  }
  const mAct = p.match(/^\/api\/actions\/(\d+)$/);
  if (mAct && m === "PATCH") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (!canSeeAll(me.role)) return J({ ok: false, error: "forbidden" }, 403);
    const b = await request.json().catch(() => ({}));
    if (!["approved", "dismissed", "done", "proposed"].includes(b.status)) return J({ ok: false, message: "狀態不對。" }, 400);
    await db.run("UPDATE actions SET status = ?, decided_at = ?, decided_by = ?, result_note = COALESCE(?, result_note) WHERE id = ?",
      b.status, now(), me.id, typeof b.result_note === "string" ? b.result_note.slice(0, 500) : null, Number(mAct[1]));
    return J({ ok: true });
  }
  const mDis = p.match(/^\/api\/insights\/(\d+)$/);
  if (mDis && m === "PATCH") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    if (!canSeeAll(me.role)) return J({ ok: false, error: "forbidden" }, 403);
    const b = await request.json().catch(() => ({}));
    await db.run("UPDATE insights SET dismissed = ? WHERE id = ?", b.dismissed ? 1 : 0, Number(mDis[1]));
    return J({ ok: true });
  }

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
  /* 前端探測有沒有示範模式：GET 永遠 200，不再用 403 當訊號（會在 console 留紅字） */
  if (p === "/api/demo-login" && m === "GET") return J({ ok: true, demo: env.DEMO_MODE === "on" });
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
  /* ── 畫面用的讀取 API（搜尋／leads／需要注意／預約／成交明細／週序列）── */
  if (p.startsWith("/api/search") || p.startsWith("/api/leads") || p === "/api/attention" || p === "/api/appointments" || p === "/api/deals/list" || p === "/api/series") {
    const me = await currentUser(request, db);
    if (!me) return J({ ok: false, error: "not_logged_in" }, 401);
    const r = await handleViews(url, m, db, me);
    if (r) return r;
  }

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
