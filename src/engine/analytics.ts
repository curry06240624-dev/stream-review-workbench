/**
 * 分析層 —— 全部是普通程式算的決定性數字。AI 不碰算術。
 *
 * 每個數字都帶樣本數 n，畫面必須顯示；「轉換率 100%」的 n 如果是 2，不是洞察，是巧合。
 * 期間預設「最近 7 天 vs 前 7 天」，事件用 at 判定、lead 用 opened_at、成交用 closed_at。
 */
import type { DbLike } from "../adapters/import.ts";

type Row = Record<string, unknown>;
const D = 86_400_000;
const num = (v: unknown) => Number(v ?? 0) || 0;
const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
const iso = (t: number) => new Date(t).toISOString();

export interface Period { from: string; to: string; days: number; }
export interface Analytics {
  period: Period; prev: Period;
  funnel: { events: Record<string, number>; prev_events: Record<string, number>; leads: number; prev_leads: number; stages: Array<{ stage: string; n: number }> };
  conversion: Record<string, { rate: number | null; n: number; prev_rate: number | null; prev_n: number }>;
  price_dropoff: {
    count: number; base: number; rate: number | null; prev_count: number; prev_base: number; prev_rate: number | null;
    by_confidence: Record<string, number>;
    by_body_type: Array<{ body_type: string; priced: number; dropped: number; rate: number | null }>;
    by_staff: Array<{ staff: string; priced: number; dropped: number; rate: number | null }>;
    by_vehicle: Array<{ vehicle: string; priced: number; dropped: number; rate: number | null }>;
  };
  appointments: Record<string, number | null>;
  visits: Record<string, number | null>;
  /** 毛利只算「成本知道」的成交（cost_source<>'none'）；gp_estimate＝其中幾筆是車源表成本估算的；正式毛利以會計為準 */
  deals: {
    sold: number; lost: number; revenue: number; gross_profit: number; avg_gp: number | null; gp_margin: number | null; below_cost: number;
    gp_known: number; gp_unknown: number; gp_estimate: number; peer_sold: number; revenue_known: number;
    prev_sold: number; prev_revenue: number; prev_gross_profit: number;
    lost_reasons: Array<{ reason: string; n: number }>;
    by_staff: Array<{ staff: string; sold: number; revenue: number; gross_profit: number; gp_unknown: number }>;
  };
  staff: Array<{ id: number; name: string; team: string; leads: number; priced: number; dropped: number; booked: number; sold: number; revenue: number; gross_profit: number; median_first_response_min: number | null; followups: number }>;
  vehicles: Array<{ id: number; name: string; body_type: string; inquiries: number; priced: number; dropped: number; booked: number; sold: number; inquiry_to_sold: number | null; gross_profit: number }>;
  attention: Array<{ kind: string; lead_id: number; contact: string; staff: string; vehicle: string; since: string; reason: string }>;
}

async function countEvents(db: DbLike, from: string, to: string): Promise<Record<string, number>> {
  const rows = await db.all(`SELECT type, COUNT(*) AS n FROM funnel_events WHERE at >= ? AND at < ? AND confidence <> 'UNCLEAR' GROUP BY type`, from, to);
  return Object.fromEntries(rows.map((r) => [String(r["type"]), num(r["n"])]));
}
/** 期間內「到達過 A 的 lead」中「之後到達 B」的比例（以 lead 計，不是事件計） */
async function stageRate(db: DbLike, a: string, b: string, from: string, to: string) {
  const r = await db.first(
    `SELECT COUNT(DISTINCT x.lead_id) AS n,
            COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM funnel_events y WHERE y.lead_id = x.lead_id AND y.type = ? AND y.at >= x.at AND y.confidence <> 'UNCLEAR') THEN x.lead_id END) AS k
       FROM funnel_events x WHERE x.type = ? AND x.at >= ? AND x.at < ? AND x.confidence <> 'UNCLEAR'`, b, a, from, to);
  const n = num(r?.["n"]), k = num(r?.["k"]);
  return { rate: rate(k, n), n };
}

export async function computeAnalytics(db: DbLike, opts: { to?: string; days?: number }): Promise<Analytics> {
  const days = opts.days ?? 7;
  const toT = opts.to ? Date.parse(opts.to) : Date.now();
  const fromT = toT - days * D, pFromT = fromT - days * D;
  const period: Period = { from: iso(fromT), to: iso(toT), days };
  const prev: Period = { from: iso(pFromT), to: iso(fromT), days };
  const P = [period.from, period.to] as const, Q = [prev.from, prev.to] as const;

  /* ── 漏斗 ── */
  const events = await countEvents(db, ...P), prev_events = await countEvents(db, ...Q);
  const leads = num((await db.first("SELECT COUNT(*) AS n FROM leads WHERE opened_at >= ? AND opened_at < ?", ...P))?.["n"]);
  const prev_leads = num((await db.first("SELECT COUNT(*) AS n FROM leads WHERE opened_at >= ? AND opened_at < ?", ...Q))?.["n"]);
  const stages = (await db.all("SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage")).map((r) => ({ stage: String(r["stage"]), n: num(r["n"]) }));

  /* ── 階段轉換（以 lead 計）── */
  const pairs: Array<[string, string, string]> = [
    ["price_to_booking", "PRICE_MENTIONED", "APPOINTMENT_BOOKED"],
    ["booking_to_visit", "APPOINTMENT_BOOKED", "STORE_VISIT"],
    ["visit_to_sold", "STORE_VISIT", "SOLD"],
    ["lead_to_sold", "NEW_LEAD", "SOLD"],
    ["price_to_sold", "PRICE_MENTIONED", "SOLD"],
  ];
  const conversion: Analytics["conversion"] = {};
  for (const [k, a, b] of pairs) {
    const c = await stageRate(db, a, b, ...P), p = await stageRate(db, a, b, ...Q);
    conversion[k] = { rate: c.rate, n: c.n, prev_rate: p.rate, prev_n: p.n };
  }

  /* ── 價格後流失 ── */
  const dropQ = `SELECT COUNT(*) AS n FROM funnel_events WHERE type = 'PRICE_DROP_OFF' AND confidence IN ('CONFIRMED','STRONGLY_SUGGESTED','POSSIBLE') AND at >= ? AND at < ?`;
  const priceQ = `SELECT COUNT(*) AS n FROM funnel_events WHERE type = 'PRICE_MENTIONED' AND at >= ? AND at < ?`;
  const dCount = num((await db.first(dropQ, ...P))?.["n"]), dBase = num((await db.first(priceQ, ...P))?.["n"]);
  const pdCount = num((await db.first(dropQ, ...Q))?.["n"]), pdBase = num((await db.first(priceQ, ...Q))?.["n"]);
  const byConf = Object.fromEntries((await db.all(`SELECT confidence, COUNT(*) AS n FROM funnel_events WHERE type = 'PRICE_DROP_OFF' AND at >= ? AND at < ? GROUP BY confidence`, ...P)).map((r) => [String(r["confidence"]), num(r["n"])]));
  const breakdown = async (dim: string, joinSql: string, label: string) => (await db.all(
    `SELECT ${label} AS k,
            SUM(CASE WHEN e.type = 'PRICE_MENTIONED' THEN 1 ELSE 0 END) AS priced,
            SUM(CASE WHEN e.type = 'PRICE_DROP_OFF' AND e.confidence <> 'UNCLEAR' THEN 1 ELSE 0 END) AS dropped
       FROM funnel_events e JOIN leads l ON l.id = e.lead_id ${joinSql}
      WHERE e.type IN ('PRICE_MENTIONED','PRICE_DROP_OFF') AND e.at >= ? AND e.at < ?
      GROUP BY k HAVING priced > 0 ORDER BY dropped DESC, priced DESC LIMIT 8`, ...P))
    .map((r) => ({ [dim]: String(r["k"] ?? "（未知）"), priced: num(r["priced"]), dropped: num(r["dropped"]), rate: rate(num(r["dropped"]), num(r["priced"])) }));
  const price_dropoff: Analytics["price_dropoff"] = {
    count: dCount, base: dBase, rate: rate(dCount, dBase), prev_count: pdCount, prev_base: pdBase, prev_rate: rate(pdCount, pdBase),
    by_confidence: byConf,
    by_body_type: (await breakdown("body_type", "LEFT JOIN vehicles v ON v.id = l.vehicle_id", "COALESCE(v.body_type,'')")) as never,
    by_staff: (await breakdown("staff", "LEFT JOIN users u ON u.id = l.staff_id", "COALESCE(u.name,'未指派')")) as never,
    by_vehicle: (await breakdown("vehicle", "LEFT JOIN vehicles v ON v.id = l.vehicle_id", "COALESCE(v.brand || ' ' || v.model,'')")) as never,
  };

  /* ── 預約與到店 ── */
  const cnt = async (type: string, pp: readonly [string, string]) => num((await db.first(`SELECT COUNT(*) AS n FROM funnel_events WHERE type = ? AND confidence <> 'UNCLEAR' AND at >= ? AND at < ?`, type, ...pp))?.["n"]);
  const aProp = await cnt("APPOINTMENT_PROPOSED", P), aBook = await cnt("APPOINTMENT_BOOKED", P), aNo = await cnt("NO_SHOW", P), aCxl = await cnt("APPOINTMENT_CANCELLED", P), aChg = await cnt("APPOINTMENT_CHANGED", P), vis = await cnt("STORE_VISIT", P);
  const pBook = await cnt("APPOINTMENT_BOOKED", Q), pNo = await cnt("NO_SHOW", Q), pVis = await cnt("STORE_VISIT", Q), pProp = await cnt("APPOINTMENT_PROPOSED", Q);
  const appointments = { proposed: aProp, booked: aBook, no_show: aNo, cancelled: aCxl, changed: aChg, booking_rate: rate(aBook, aProp), no_show_rate: rate(aNo, aBook), prev_booked: pBook, prev_no_show: pNo, prev_proposed: pProp, prev_booking_rate: rate(pBook, pProp), prev_no_show_rate: rate(pNo, pBook) };
  const vOut = Object.fromEntries((await db.all(`SELECT outcome, COUNT(*) AS n FROM visits WHERE visited_at >= ? AND visited_at < ? GROUP BY outcome`, ...P)).map((r) => [String(r["outcome"]), num(r["n"])]));
  const visits = { count: vis, prev_count: pVis, bought: vOut["bought"] ?? 0, negotiating: vOut["negotiating"] ?? 0, left: vOut["left"] ?? 0, booking_to_visit: conversion["booking_to_visit"]?.rate ?? null, visit_to_sold: conversion["visit_to_sold"]?.rate ?? null };

  /* ── 成交/毛利（帳本；毛利只算成本知道的成交）── */
  const GP = "CASE WHEN status='sold' AND cost_source<>'none' THEN gross_profit ELSE 0 END";
  const dl = await db.first(`SELECT SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold, SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) AS lost,
      SUM(CASE WHEN status='sold' THEN sale_price ELSE 0 END) AS revenue, SUM(${GP}) AS gp,
      SUM(CASE WHEN status='sold' AND cost_source<>'none' THEN sale_price ELSE 0 END) AS revenue_known,
      SUM(CASE WHEN status='sold' AND cost_source<>'none' THEN 1 ELSE 0 END) AS gp_known, SUM(CASE WHEN status='sold' AND cost_source='none' THEN 1 ELSE 0 END) AS gp_unknown,
      SUM(CASE WHEN status='sold' AND gp_is_estimate=1 AND cost_source<>'none' THEN 1 ELSE 0 END) AS gp_est, SUM(CASE WHEN status='sold' AND source_kind='peer' THEN 1 ELSE 0 END) AS peer,
      SUM(CASE WHEN status='sold' AND cost_source<>'none' AND gross_profit < 0 THEN 1 ELSE 0 END) AS below FROM deals WHERE closed_at >= ? AND closed_at < ?`, ...P);
  const pdl = await db.first(`SELECT SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold, SUM(CASE WHEN status='sold' THEN sale_price ELSE 0 END) AS revenue, SUM(${GP}) AS gp FROM deals WHERE closed_at >= ? AND closed_at < ?`, ...Q);
  const sold = num(dl?.["sold"]), revenue = num(dl?.["revenue"]), gp = num(dl?.["gp"]), gpKnown = num(dl?.["gp_known"]);
  const deals: Analytics["deals"] = {
    sold, lost: num(dl?.["lost"]), revenue, gross_profit: gp, avg_gp: gpKnown ? Math.round(gp / gpKnown) : null, gp_margin: rate(gp, num(dl?.["revenue_known"])), below_cost: num(dl?.["below"]),
    gp_known: gpKnown, gp_unknown: num(dl?.["gp_unknown"]), gp_estimate: num(dl?.["gp_est"]), peer_sold: num(dl?.["peer"]), revenue_known: num(dl?.["revenue_known"]),
    prev_sold: num(pdl?.["sold"]), prev_revenue: num(pdl?.["revenue"]), prev_gross_profit: num(pdl?.["gp"]),
    lost_reasons: (await db.all(`SELECT lost_reason AS reason, COUNT(*) AS n FROM deals WHERE status='lost' AND closed_at >= ? AND closed_at < ? GROUP BY lost_reason ORDER BY n DESC`, ...P)).map((r) => ({ reason: String(r["reason"] || "unknown"), n: num(r["n"]) })),
    by_staff: (await db.all(`SELECT COALESCE(u.name,'未指派') AS staff, COUNT(*) AS sold, SUM(d.sale_price) AS revenue, SUM(CASE WHEN d.cost_source<>'none' THEN d.gross_profit ELSE 0 END) AS gp, SUM(CASE WHEN d.cost_source='none' THEN 1 ELSE 0 END) AS unk FROM deals d LEFT JOIN users u ON u.id = d.staff_id WHERE d.status='sold' AND d.closed_at >= ? AND d.closed_at < ? GROUP BY staff ORDER BY gp DESC`, ...P)).map((r) => ({ staff: String(r["staff"]), sold: num(r["sold"]), revenue: num(r["revenue"]), gross_profit: num(r["gp"]), gp_unknown: num(r["unk"]) })),
  };

  /* ── 業務（全期間，不只本週：跟進品質要看足夠樣本）── */
  const staffRows = await db.all(`
    SELECT u.id, u.name, COALESCE(t.name,'') AS team,
      (SELECT COUNT(*) FROM leads l WHERE l.staff_id = u.id) AS leads,
      (SELECT COUNT(*) FROM funnel_events e JOIN leads l ON l.id = e.lead_id WHERE l.staff_id = u.id AND e.type='PRICE_MENTIONED') AS priced,
      (SELECT COUNT(*) FROM funnel_events e JOIN leads l ON l.id = e.lead_id WHERE l.staff_id = u.id AND e.type='PRICE_DROP_OFF' AND e.confidence<>'UNCLEAR') AS dropped,
      (SELECT COUNT(*) FROM funnel_events e JOIN leads l ON l.id = e.lead_id WHERE l.staff_id = u.id AND e.type='APPOINTMENT_BOOKED') AS booked,
      (SELECT COUNT(*) FROM deals d WHERE d.staff_id = u.id AND d.status='sold') AS sold,
      (SELECT COALESCE(SUM(d.sale_price),0) FROM deals d WHERE d.staff_id = u.id AND d.status='sold') AS revenue,
      (SELECT COALESCE(SUM(d.gross_profit),0) FROM deals d WHERE d.staff_id = u.id AND d.status='sold' AND d.cost_source<>'none') AS gp,
      (SELECT COUNT(*) FROM funnel_events e JOIN leads l ON l.id = e.lead_id WHERE l.staff_id = u.id AND e.type='FOLLOW_UP') AS followups
    FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.role = 'agent' OR u.job IN ('chat','sales','both') ORDER BY gp DESC`);
  // 首次回覆時間中位數：客戶第一則 → 該員第一則
  const staff: Analytics["staff"] = [];
  for (const r of staffRows) {
    const lat = (await db.all(`
      SELECT (julianday(s.created_at) - julianday(c.created_at)) * 1440 AS mins
        FROM conversations cv
        JOIN messages c ON c.id = (SELECT id FROM messages WHERE conversation_id = cv.id AND sender_role='customer' ORDER BY created_at LIMIT 1)
        JOIN messages s ON s.id = (SELECT id FROM messages WHERE conversation_id = cv.id AND sender_role='staff' AND created_at > c.created_at ORDER BY created_at LIMIT 1)
       WHERE cv.assigned_to = ?`, r["id"])).map((x) => num(x["mins"])).sort((a, b) => a - b);
    const med = lat.length ? lat[Math.floor(lat.length / 2)]! : null;
    staff.push({ id: num(r["id"]), name: String(r["name"]), team: String(r["team"]), leads: num(r["leads"]), priced: num(r["priced"]), dropped: num(r["dropped"]), booked: num(r["booked"]), sold: num(r["sold"]), revenue: num(r["revenue"]), gross_profit: num(r["gp"]), median_first_response_min: med === null ? null : Math.round(med), followups: num(r["followups"]) });
  }

  /* ── 車款（全期間）── */
  const vehicles: Analytics["vehicles"] = (await db.all(`
    SELECT v.id, v.brand || ' ' || v.model AS name, v.body_type,
      (SELECT COUNT(*) FROM leads l WHERE l.vehicle_id = v.id) AS inquiries,
      (SELECT COUNT(*) FROM funnel_events e JOIN leads l ON l.id = e.lead_id WHERE l.vehicle_id = v.id AND e.type='PRICE_MENTIONED') AS priced,
      (SELECT COUNT(*) FROM funnel_events e JOIN leads l ON l.id = e.lead_id WHERE l.vehicle_id = v.id AND e.type='PRICE_DROP_OFF' AND e.confidence<>'UNCLEAR') AS dropped,
      (SELECT COUNT(*) FROM funnel_events e JOIN leads l ON l.id = e.lead_id WHERE l.vehicle_id = v.id AND e.type='APPOINTMENT_BOOKED') AS booked,
      (SELECT COUNT(*) FROM deals d WHERE d.vehicle_id = v.id AND d.status='sold') AS sold,
      (SELECT COALESCE(SUM(d.gross_profit),0) FROM deals d WHERE d.vehicle_id = v.id AND d.status='sold' AND d.cost_source<>'none') AS gp
    FROM vehicles v ORDER BY inquiries DESC`))
    .map((r) => ({ id: num(r["id"]), name: String(r["name"]), body_type: String(r["body_type"]), inquiries: num(r["inquiries"]), priced: num(r["priced"]), dropped: num(r["dropped"]), booked: num(r["booked"]), sold: num(r["sold"]), inquiry_to_sold: rate(num(r["sold"]), num(r["inquiries"])), gross_profit: num(r["gp"]) }));

  /* ── 需要注意（現在）── */
  const attention: Analytics["attention"] = [];
  const base = `SELECT l.id AS lead_id, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact, COALESCE(u.name,'未指派') AS staff, COALESCE(v.brand || ' ' || v.model,'') AS vehicle
                  FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = l.staff_id LEFT JOIN vehicles v ON v.id = l.vehicle_id`;
  const openOnly = `l.outcome = '' AND NOT EXISTS (SELECT 1 FROM funnel_events z WHERE z.lead_id = l.id AND z.type IN ('SOLD','LOST') AND z.confidence <> 'POSSIBLE')`;
  const push = (kind: string, rows: Row[], reason: (r: Row) => string) => { for (const r of rows) attention.push({ kind, lead_id: num(r["lead_id"]), contact: String(r["contact"]), staff: String(r["staff"]), vehicle: String(r["vehicle"]), since: String(r["since"] ?? ""), reason: reason(r) }); };
  push("high_intent_no_followup", await db.all(`${base} JOIN funnel_events h ON h.lead_id = l.id AND h.type='HIGH_INTENT'
      WHERE ${openOnly} AND NOT EXISTS (SELECT 1 FROM funnel_events f WHERE f.lead_id = l.id AND f.type='FOLLOW_UP' AND f.at > h.at)
        AND (SELECT MAX(m.created_at) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.lead_id = l.id AND m.sender_role='customer') < ?
      ORDER BY h.at DESC LIMIT 10`, iso(toT - D)), () => "客戶早期表達急迫，之後沒有任何跟進");
  push("price_dropoff_no_followup", await db.all(`${base} JOIN funnel_events p ON p.lead_id = l.id AND p.type='PRICE_DROP_OFF' AND p.confidence IN ('CONFIRMED','STRONGLY_SUGGESTED')
      WHERE ${openOnly} AND p.at >= ? AND NOT EXISTS (SELECT 1 FROM funnel_events f WHERE f.lead_id = l.id AND f.type='FOLLOW_UP' AND f.at > p.at)
      ORDER BY p.at DESC LIMIT 10`, iso(toT - 14 * D)), () => "報價後流失，兩週內沒有人再跟進");
  push("booked_but_no_visit", await db.all(`${base} JOIN appointments a ON a.lead_id = l.id AND a.status='booked' AND a.scheduled_for < ?
      WHERE ${openOnly} AND NOT EXISTS (SELECT 1 FROM visits x WHERE x.lead_id = l.id) LIMIT 10`, iso(toT)), () => "預約時間已過，沒有到店也沒有標記爽約");
  push("financing_unresolved", await db.all(`${base} JOIN funnel_events q ON q.lead_id = l.id AND q.type='FINANCING_QUESTION' AND q.detail LIKE '%"resolved":false%'
      WHERE ${openOnly} AND q.at >= ? LIMIT 10`, iso(toT - 14 * D)), () => "客戶問了貸款，業務沒有給具體答案");

  return { period, prev, funnel: { events, prev_events, leads, prev_leads, stages }, conversion, price_dropoff, appointments, visits, deals, staff, vehicles, attention };
}
