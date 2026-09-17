/**
 * 畫面用的讀取 API：搜尋、lead 清單與明細、需要注意、預約、成交明細、週序列。
 * 全部唯讀。權限：admin／operator 看全公司；agent 只看自己的 lead（SQL 層擋，看不到一律 404）。
 */
import type { DbLike } from "../adapters/import.ts";
import { computeAnalytics } from "../engine/analytics.ts";

type Row = Record<string, unknown>;
interface Me { id: number; role: string; name: string; }
const D = 86_400_000;
const num = (v: unknown) => Number(v ?? 0) || 0;
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const canSeeAll = (r: string) => r === "admin" || r === "operator";
const S = (v: unknown, n = 80) => String(v ?? "").trim().slice(0, n);
/** 分析數字優先走 DO 端的快取版（免費方案列讀取有限）；沒有那個方法（測試用的假 db）才在這裡算 */
const analytics = (db: DbLike, opts: { days: number; to?: string }) => {
  const local = (db as unknown as { analyticsLocal?: (o: { days: number; to?: string }) => Promise<Awaited<ReturnType<typeof computeAnalytics>>> }).analyticsLocal;
  return local ? (db as unknown as { analyticsLocal: (o: { days: number; to?: string }) => ReturnType<typeof computeAnalytics> }).analyticsLocal(opts) : computeAnalytics(db, opts);   // 不能 .call：db 是 DO 的 RPC 代理，.call 會被當成遠端方法
};

/** 期間終點：?anchor=today → 現在；否則資料末端（最後一則訊息＋1 秒，不晚於現在；跟 db.js dataEndLocal 同一條規則）。to 為 undefined＝到今天 */
async function periodEnd(db: DbLike, q: URLSearchParams): Promise<{ iso: string; to: string | undefined }> {
  const nowIso = new Date().toISOString();
  if (q.get("anchor") === "today") return { iso: nowIso, to: undefined };
  const r = await db.first("SELECT MAX(m) AS m FROM (SELECT MAX(last_message_at) AS m FROM conversations UNION ALL SELECT MAX(reported_at) AS m FROM deal_reports UNION ALL SELECT MAX(at) AS m FROM group_posts)");   // 跟 db.js dataEndLocal 同一條規則
  const t = r && r["m"] ? Date.parse(String(r["m"])) + 1000 : NaN;
  if (!Number.isFinite(t) || t >= Date.now()) return { iso: nowIso, to: undefined };
  const iso = new Date(t).toISOString(); return { iso, to: iso };
}

const LEAD_SELECT = `
  SELECT l.id, l.stage, l.outcome, l.opened_at, l.closed_at, l.source, l.staff_id, l.vehicle_id,
         c.id AS contact_id, c.pseudonym, c.display_name, c.grade, c.first_contact_at,
         COALESCE(u.name,'') AS staff, COALESCE(v.brand || ' ' || v.model,'') AS vehicle, COALESCE(v.body_type,'') AS body_type, v.list_price, v.sell_price, l.grade_auto, l.grade_reason, l.result_tag,
         cv.id AS conversation_id, cv.last_message_at AS last_at, cv.unread, cv.coverage, cv.coverage_note,
         (SELECT text FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_text,
         (SELECT sender_role FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_role,
         EXISTS (SELECT 1 FROM funnel_events e WHERE e.lead_id = l.id AND e.type='PRICE_DROP_OFF' AND e.confidence IN ('CONFIRMED','STRONGLY_SUGGESTED')) AS f_price_dropoff,
         EXISTS (SELECT 1 FROM funnel_events e WHERE e.lead_id = l.id AND e.type='HIGH_INTENT') AS f_high_intent,
         EXISTS (SELECT 1 FROM funnel_events e WHERE e.lead_id = l.id AND e.type='FINANCING_QUESTION' AND e.detail LIKE '%"resolved":false%') AS f_financing
    FROM leads l JOIN contacts c ON c.id = l.contact_id
    LEFT JOIN users u ON u.id = l.staff_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
    LEFT JOIN conversations cv ON cv.id = (SELECT id FROM conversations WHERE lead_id = l.id ORDER BY id LIMIT 1)`;

const shapeLead = (r: Row) => ({
  id: num(r["id"]), stage: r["stage"], outcome: r["outcome"], opened_at: r["opened_at"], closed_at: r["closed_at"], source: r["source"],
  staff_id: r["staff_id"], vehicle_id: r["vehicle_id"], contact_id: r["contact_id"], pseudonym: r["pseudonym"] || r["display_name"], display_name: r["display_name"],
  grade: r["grade"], first_contact_at: r["first_contact_at"], staff: r["staff"], vehicle: r["vehicle"], body_type: r["body_type"], list_price: r["list_price"], sell_price: r["sell_price"], grade_auto: r["grade_auto"] || "", grade_reason: r["grade_reason"] || "", result_tag: r["result_tag"] || "",
  conversation_id: r["conversation_id"], last_at: r["last_at"], unread: num(r["unread"]), last_text: r["last_text"], last_role: r["last_role"],
  coverage: r["coverage"] || "full", coverage_note: r["coverage_note"] || "",
  flags: { price_dropoff: !!num(r["f_price_dropoff"]), high_intent: !!num(r["f_high_intent"]), financing_unresolved: !!num(r["f_financing"]) },
});

export async function handleViews(url: URL, method: string, db: DbLike, me: Me): Promise<Response | null> {
  const p = url.pathname, q = url.searchParams;
  const mine = canSeeAll(me.role) ? "" : ` AND l.staff_id = ${Number(me.id)}`;
  if (method !== "GET") return null;

  /* ── 搜尋（指令列）── */
  if (p === "/api/search") {
    const s = S(q.get("q"), 40); if (!s) return J({ ok: true, results: [] });
    const like = `%${s}%`;
    const custs = await db.all(`SELECT l.id, c.pseudonym, c.display_name, COALESCE(v.brand||' '||v.model,'') AS vehicle FROM leads l JOIN contacts c ON c.id=l.contact_id LEFT JOIN vehicles v ON v.id=l.vehicle_id
      WHERE (c.pseudonym LIKE ? OR c.display_name LIKE ?)${mine} ORDER BY l.opened_at DESC LIMIT 5`, like, like);
    const staff = canSeeAll(me.role) ? await db.all(`SELECT id, name FROM users WHERE role='agent' AND name LIKE ? LIMIT 3`, like) : [];
    const vehs = await db.all(`SELECT id, brand, model FROM vehicles WHERE brand||' '||model LIKE ? LIMIT 3`, like);
    const results = [
      ...custs.map((r) => ({ type: "customer", type_label: "客戶", label: String(r["pseudonym"] || r["display_name"]), sub: String(r["vehicle"]), href: `/conversations/${r["id"]}` })),
      ...staff.map((r) => ({ type: "staff", type_label: "業務", label: String(r["name"]), sub: "", href: `/conversations?staff=${encodeURIComponent(String(r["name"]))}` })),
      ...vehs.map((r) => ({ type: "vehicle", type_label: "車款", label: `${r["brand"]} ${r["model"]}`, sub: "", href: `/conversations?vehicle=${encodeURIComponent(`${r["brand"]} ${r["model"]}`)}` })),
    ];
    return J({ ok: true, results });
  }

  /* ── lead 清單 ── */
  if (p === "/api/leads") {
    const where: string[] = ["1=1"]; const args: unknown[] = [];
    const s = S(q.get("q"), 40); if (s) { where.push("(c.pseudonym LIKE ? OR c.display_name LIKE ? OR (v.brand||' '||v.model) LIKE ?)"); args.push(`%${s}%`, `%${s}%`, `%${s}%`); }
    if (q.get("stage")) { where.push("l.stage = ?"); args.push(S(q.get("stage"), 20)); }
    if (q.get("grade")) { where.push("l.grade_auto = ?"); args.push(S(q.get("grade"), 2)); }
    if (q.get("tag")) { where.push("l.result_tag LIKE ?"); args.push(`%${S(q.get("tag"), 10)}%`); }
    if (q.get("staff")) { where.push("u.name = ?"); args.push(S(q.get("staff"), 40)); }
    if (q.get("vehicle")) { where.push("(v.brand||' '||v.model) = ?"); args.push(S(q.get("vehicle"), 60)); }
    if (q.get("outcome") === "open") where.push("l.outcome = ''"); else if (q.get("outcome")) { where.push("l.outcome = ?"); args.push(S(q.get("outcome"), 10)); }
    if (q.get("insight")) { where.push("l.id IN (SELECT lead_id FROM evidence WHERE insight_id = ?)"); args.push(Number(q.get("insight"))); }
    const flag = q.get("flag");
    if (flag === "price_dropoff") where.push("EXISTS (SELECT 1 FROM funnel_events e WHERE e.lead_id=l.id AND e.type='PRICE_DROP_OFF' AND e.confidence IN ('CONFIRMED','STRONGLY_SUGGESTED'))");
    if (flag === "high_intent") where.push("EXISTS (SELECT 1 FROM funnel_events e WHERE e.lead_id=l.id AND e.type='HIGH_INTENT')");
    if (flag === "financing") where.push("EXISTS (SELECT 1 FROM funnel_events e WHERE e.lead_id=l.id AND e.type='FINANCING_QUESTION' AND e.detail LIKE '%\"resolved\":false%')");
    if (flag === "insights") where.push("l.id IN (SELECT lead_id FROM evidence WHERE insight_id IS NOT NULL)");
    const event = S(q.get("event"), 30); if (event) { where.push("EXISTS (SELECT 1 FROM funnel_events e WHERE e.lead_id=l.id AND e.type=? AND e.confidence<>'UNCLEAR')"); args.push(event); }
    const limit = Math.min(200, Math.max(1, Number(q.get("limit") || 60)));
    const rows = await db.all(`${LEAD_SELECT} WHERE ${where.join(" AND ")}${mine} ORDER BY COALESCE(cv.last_message_at, l.opened_at) DESC LIMIT ${limit}`, ...args);
    return J({ ok: true, leads: rows.map(shapeLead), n: rows.length });
  }

  /* ── lead 明細：對話＋事件＋證據＋洞察＋動作 ── */
  const mL = p.match(/^\/api\/leads\/(\d+)$/);
  if (mL) {
    const id = Number(mL[1]);
    const row = await db.first(`${LEAD_SELECT} WHERE l.id = ?${mine}`, id);
    if (!row) return J({ ok: false, message: "找不到。" }, 404);
    const lead = shapeLead(row);
    const messages = await db.all(`SELECT m.id, m.sender_role, m.text, m.created_at, m.msg_type, u.name AS staff_name FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id
      WHERE m.conversation_id = ? ORDER BY m.created_at, m.id`, lead.conversation_id ?? 0);
    const evRows = await db.all(`SELECT e.id, e.type, e.at, e.confidence, e.source, e.detail FROM funnel_events e WHERE e.lead_id = ? ORDER BY e.at, e.id`, id);
    const evid = await db.all(`SELECT x.event_id, x.message_id, x.note FROM evidence x WHERE x.lead_id = ? AND x.event_id IS NOT NULL`, id);
    const events = evRows.map((e) => ({ ...e, detail: safeJson(e["detail"]), evidence: evid.filter((x) => x["event_id"] === e["id"]).map((x) => ({ message_id: x["message_id"], note: x["note"] })) }));
    const insights = await db.all(`SELECT DISTINCT i.id, i.title, i.severity, i.kind, i.confidence FROM insights i JOIN evidence x ON x.insight_id = i.id WHERE x.lead_id = ? AND i.dismissed = 0 ORDER BY i.id DESC`, id);
    const insEvidence = await db.all(`SELECT x.insight_id, x.message_id, x.note FROM evidence x WHERE x.lead_id = ? AND x.insight_id IS NOT NULL`, id);
    const actions = insights.length ? await db.all(`SELECT a.* FROM actions a WHERE a.insight_id IN (${insights.map(() => "?").join(",")}) ORDER BY a.id`, ...insights.map((i) => i["id"])) : [];
    const appointments = await db.all("SELECT * FROM appointments WHERE lead_id = ? ORDER BY proposed_at", id);
    const visits = await db.all("SELECT * FROM visits WHERE lead_id = ? ORDER BY visited_at", id);
    const deals = await db.all("SELECT * FROM deals WHERE lead_id = ?", id);
    const roles = await db.all(`SELECT r.role, r.confidence, r.at, r.evidence_message_id, r.note, u.name AS staff FROM lead_roles r JOIN users u ON u.id = r.user_id WHERE r.lead_id = ? ORDER BY r.id`, id);
    const lossRow = await db.first("SELECT * FROM loss_analyses WHERE lead_id = ?", id);
    const lossEv = lossRow ? await db.all("SELECT message_id, note FROM evidence WHERE loss_id = ?", lossRow["id"]) : [];
    const appraisals = await db.all("SELECT * FROM appraisals WHERE lead_id = ? ORDER BY reported_at DESC", id);
    const reports = await db.all("SELECT id, reported_at, reported_by, plate, sale_price, match_status, match_confidence, source_kind, peer_dealer, loan_status FROM deal_reports WHERE lead_id = ? ORDER BY reported_at DESC", id);
    const labels = await db.all("SELECT source, target_key, human_value, note, reviewer, labeled_at FROM label_reviews WHERE lead_id = ? ORDER BY source, target_key", id);
    return J({ ok: true, lead, messages, events, insights: insights.map((i) => ({ ...i, evidence: insEvidence.filter((x) => x["insight_id"] === i["id"]) })), actions, appointments, visits, deals,
      roles, loss: lossRow ? { ...lossRow, evidence: lossEv } : null, appraisals, reports, labels });
  }

  /* ── 需要注意 ── */
  if (p === "/api/attention") {
    const pe = await periodEnd(db, q);
    const a = await analytics(db, { days: 7, to: pe.to });
    const items = canSeeAll(me.role) ? a.attention : a.attention.filter((x) => x.staff === me.name);
    const counts: Record<string, number> = {};
    for (const x of items) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
    const lastAt = items.length ? await db.all(`SELECT l.id, cv.last_message_at, c.pseudonym FROM leads l JOIN contacts c ON c.id=l.contact_id LEFT JOIN conversations cv ON cv.lead_id = l.id WHERE l.id IN (${items.map(() => "?").join(",")})`, ...items.map((x) => x.lead_id)) : [];
    const byId = new Map(lastAt.map((r) => [num(r["id"]), r]));
    const shaped = items.map((x) => ({ ...x, contact: String(byId.get(x.lead_id)?.["pseudonym"] || x.contact), last_at: byId.get(x.lead_id)?.["last_message_at"] ?? null }));
    const actions = canSeeAll(me.role) ? await db.all(`SELECT a.*, i.title AS insight_title, i.severity FROM actions a LEFT JOIN insights i ON i.id = a.insight_id WHERE a.status IN ('proposed','approved') ORDER BY CASE a.status WHEN 'approved' THEN 0 ELSE 1 END, a.id DESC LIMIT 30`) : [];
    const done = canSeeAll(me.role) ? await db.all(`SELECT a.*, i.title AS insight_title FROM actions a LEFT JOIN insights i ON i.id = a.insight_id WHERE a.status IN ('done','dismissed') ORDER BY a.decided_at DESC LIMIT 10`) : [];
    return J({ ok: true, counts, items: shaped, actions, done, as_of: pe.iso });
  }

  /* ── 預約與到店 ── */
  if (p === "/api/appointments") {
    const days = Math.min(30, Math.max(1, Number(q.get("days") || 7)));
    const pe = await periodEnd(db, q); const nowIso = pe.iso; const now = Date.parse(nowIso);
    const a = await analytics(db, { days, to: pe.to });
    const base = `SELECT ap.id, ap.lead_id, ap.scheduled_for, ap.status, ap.status_at, c.pseudonym, c.display_name, COALESCE(u.name,'') AS staff, COALESCE(v.brand||' '||v.model,'') AS vehicle,
                    EXISTS (SELECT 1 FROM visits vi WHERE vi.lead_id = ap.lead_id AND vi.visited_at >= ap.scheduled_for) AS visited
               FROM appointments ap JOIN leads l ON l.id = ap.lead_id JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = ap.staff_id LEFT JOIN vehicles v ON v.id = l.vehicle_id`;
    const timeline = await db.all(`${base} WHERE ap.scheduled_for IS NOT NULL AND ap.scheduled_for >= ? AND ap.scheduled_for < ?${mine} ORDER BY ap.scheduled_for`,
      new Date(now - 2 * D).toISOString(), new Date(now + 7 * D).toISOString());
    const watch = await db.all(`${base} WHERE ap.status = 'booked' AND ap.scheduled_for < ? AND NOT EXISTS (SELECT 1 FROM visits vi WHERE vi.lead_id = ap.lead_id)${mine} ORDER BY ap.scheduled_for DESC LIMIT 12`, nowIso);
    const recent = await db.all(`SELECT vi.lead_id, vi.visited_at, vi.outcome, vi.note, c.pseudonym, c.display_name, COALESCE(v.brand||' '||v.model,'') AS vehicle, COALESCE(u.name,'') AS staff,
        (SELECT status FROM deals d WHERE d.lead_id = vi.lead_id LIMIT 1) AS deal_status
      FROM visits vi JOIN leads l ON l.id = vi.lead_id JOIN contacts c ON c.id = l.contact_id LEFT JOIN vehicles v ON v.id = l.vehicle_id LEFT JOIN users u ON u.id = vi.staff_id
      WHERE 1=1${mine} ORDER BY vi.visited_at DESC LIMIT 12`);
    const shape = (r: Row) => ({ ...r, contact: String(r["pseudonym"] || r["display_name"]), overdue: String(r["status"]) === "booked" && Date.parse(String(r["scheduled_for"])) < now && !num(r["visited"]), visited: !!num(r["visited"]) });
    return J({ ok: true, counts: { ...a.appointments, visits: a.visits["count"], prev_visits: a.visits["prev_count"], booking_to_visit: a.conversion["booking_to_visit"], visit_to_sold: a.conversion["visit_to_sold"] },
      timeline: timeline.map(shape), watch: watch.map(shape), recent_visits: recent.map((r) => ({ ...r, contact: String(r["pseudonym"] || r["display_name"]) })), period: a.period, as_of: nowIso });
  }

  /* ── 成交明細 ── */
  if (p === "/api/deals/list") {
    const days = Math.min(90, Math.max(1, Number(q.get("days") || 30)));
    const from = new Date(Date.parse((await periodEnd(db, q)).iso) - days * D).toISOString();
    const rows = await db.all(`SELECT d.id, d.status, d.closed_at, d.sale_price, d.cost, d.gross_profit, d.lost_reason, d.lead_id,
        d.plate, d.deposit, d.loan_status, d.delivery_by, d.reported_by, d.source_kind, d.peer_dealer, d.cost_source, d.gp_is_estimate, d.report_id, d.source_system, d.price_source, d.sheet_status, d.delivered, COALESCE(d.closed_at_source,'') AS closed_at_source,
        c.pseudonym, c.display_name, COALESCE(u.name,'') AS staff, COALESCE(v.brand||' '||v.model,'') AS vehicle, COALESCE(v.plate,'') AS vehicle_plate, v.sell_price AS vehicle_sell_price, l.opened_at
      FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN users u ON u.id = d.staff_id LEFT JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN leads l ON l.id = d.lead_id
      WHERE d.closed_at >= ?${mine.replace("l.staff_id", "d.staff_id")} ORDER BY d.closed_at DESC LIMIT 200`, from);
    const shaped = rows.map((r) => ({ ...r, contact: String(r["pseudonym"] || r["display_name"] || (r["source_system"] === "sheet" ? "（車源表，還沒對到客戶）" : "")), gp_known: String(r["cost_source"] ?? "ledger") !== "none", days: r["opened_at"] ? Math.round((Date.parse(String(r["closed_at"])) - Date.parse(String(r["opened_at"]))) / D) : null }));
    return J({ ok: true, rows: shaped, days });
  }

  /* ── 週序列（KPI sparkline 與趨勢圖）── */
  if (p === "/api/series") {
    const weeks = Math.min(16, Math.max(2, Number(q.get("weeks") || 10)));
    const now = Date.parse((await periodEnd(db, q)).iso); const out = [];   // 週桶從期間終點往回切
    for (let i = weeks - 1; i >= 0; i--) {
      const to = new Date(now - i * 7 * D).toISOString(), from = new Date(now - (i + 1) * 7 * D).toISOString();
      const ev = await db.all(`SELECT type, COUNT(*) AS n FROM funnel_events WHERE at >= ? AND at < ? AND confidence <> 'UNCLEAR' AND type IN ('NEW_LEAD','PRICE_MENTIONED','APPOINTMENT_BOOKED','STORE_VISIT','SOLD','PRICE_DROP_OFF') GROUP BY type`, from, to);
      const e = Object.fromEntries(ev.map((r) => [String(r["type"]), num(r["n"])]));
      const nl = await db.first("SELECT COUNT(*) AS n FROM leads WHERE first_real_at >= ? AND first_real_at < ?", from, to);   // 新進線跟 KPI 同源（first_real_at），不再用 NEW_LEAD 事件
      const d = await db.first(`SELECT SUM(CASE WHEN status='sold' THEN sale_price ELSE 0 END) AS rev, SUM(CASE WHEN status='sold' AND cost_source<>'none' THEN gross_profit ELSE 0 END) AS gp, SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold FROM deals WHERE closed_at >= ? AND closed_at < ?`, from, to);
      out.push({ week_end: to.slice(0, 10), leads: num(nl?.["n"]), priced: e["PRICE_MENTIONED"] ?? 0, booked: e["APPOINTMENT_BOOKED"] ?? 0, visits: e["STORE_VISIT"] ?? 0, sold: num(d?.["sold"]), dropoff: e["PRICE_DROP_OFF"] ?? 0, revenue: num(d?.["rev"]), gp: num(d?.["gp"]) });
    }
    return J({ ok: true, weeks: out });
  }
  return null;
}

function safeJson(v: unknown): Record<string, unknown> { try { return JSON.parse(String(v || "{}")); } catch { return {}; } }
