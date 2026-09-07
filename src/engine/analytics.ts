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
  funnel: { events: Record<string, number>; prev_events: Record<string, number>; leads: number; prev_leads: number; typed_leads: number; prev_typed_leads: number; stages: Array<{ stage: string; n: number }> };   // typed＝客戶自己打過字的新進線
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
    undated: { n: number; amount: number; undelivered: number };   // 車源表第一次匯入就已經是售出／收訂的：成交日不明，不算本期成交，另列
    undelivered: number; undelivered_amount: number; sheet_sold: number; sheet_vanished: number;   // 本期成交裡還沒交車的（收訂／送貸／過件）；來自車源表的；其中從車源表消失推定的
    lost_reasons: Array<{ reason: string; n: number }>;
    by_staff: Array<{ staff: string; sold: number; revenue: number; gross_profit: number; gp_unknown: number }>;
  };
  staff: Array<{ id: number; name: string; team: string; leads: number; priced: number; dropped: number; booked: number; sold: number; revenue: number; gross_profit: number; median_first_response_min: number | null; followups: number }>;
  vehicles: Array<{ id: number; name: string; body_type: string; inquiries: number; priced: number; dropped: number; booked: number; sold: number; inquiry_to_sold: number | null; gross_profit: number; list_price: number; sell_price: number | null; est_gp: number | null; stock_status: string }>;
  grades: { open: Record<string, number>; period: Record<string, number>; long_cycle: number; tags: Record<string, number> };   // SABC 系統推算：未結案客戶現況／本期新進線分布
  attention: Array<{ kind: string; lead_id: number; contact: string; staff: string; vehicle: string; since: string; reason: string }>;
  timings?: Record<string, number>;
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
  const timings: Record<string, number> = {}; let tMark = Date.now();
  const lap = (k: string) => { const t = Date.now(); timings[k] = t - tMark; tMark = t; };
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
  // 新進線裡「客戶自己打過字」的（只按選單／貼圖的不算）：瑋瑋的人講的「進線」多半是這個；兩個數字都給
  const typedQ = `SELECT COUNT(*) AS n FROM leads l WHERE l.opened_at >= ? AND l.opened_at < ? AND EXISTS (SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.lead_id = l.id AND m.sender_role = 'customer' AND COALESCE(m.msg_type,'text') NOT IN ('menu','sticker','image','video','audio','file','location')
        AND m.text NOT IN ('回選單','一年加油金','瑋瑋中古車品牌理念','我要諮詢哪裡瑕疵','貸款','售後保固','想了解月繳款','線上車庫','❤️國產車','❤️進口車','🚎露營車','1','2','3','4'))`;   // 沒標成選單的按鈕文字（跟 funnel.ts menuLike 同一份）
  const typed_leads = num((await db.first(typedQ, ...P))?.["n"]), prev_typed_leads = num((await db.first(typedQ, ...Q))?.["n"]);
  const stages = (await db.all("SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage")).map((r) => ({ stage: String(r["stage"]), n: num(r["n"]) }));

  lap("funnel");
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

  lap("conversion");
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

  lap("dropoff");
  /* ── 預約與到店 ── */
  const cnt = async (type: string, pp: readonly [string, string]) => num((await db.first(`SELECT COUNT(*) AS n FROM funnel_events WHERE type = ? AND confidence <> 'UNCLEAR' AND at >= ? AND at < ?`, type, ...pp))?.["n"]);
  const aProp = await cnt("APPOINTMENT_PROPOSED", P), aBook = await cnt("APPOINTMENT_BOOKED", P), aNo = await cnt("NO_SHOW", P), aCxl = await cnt("APPOINTMENT_CANCELLED", P), aChg = await cnt("APPOINTMENT_CHANGED", P), vis = await cnt("STORE_VISIT", P);
  const pBook = await cnt("APPOINTMENT_BOOKED", Q), pNo = await cnt("NO_SHOW", Q), pVis = await cnt("STORE_VISIT", Q), pProp = await cnt("APPOINTMENT_PROPOSED", Q);
  const appointments = { proposed: aProp, booked: aBook, no_show: aNo, cancelled: aCxl, changed: aChg, booking_rate: rate(aBook, aProp), no_show_rate: rate(aNo, aBook), prev_booked: pBook, prev_no_show: pNo, prev_proposed: pProp, prev_booking_rate: rate(pBook, pProp), prev_no_show_rate: rate(pNo, pBook) };
  const vOut = Object.fromEntries((await db.all(`SELECT outcome, COUNT(*) AS n FROM visits WHERE visited_at >= ? AND visited_at < ? GROUP BY outcome`, ...P)).map((r) => [String(r["outcome"]), num(r["n"])]));
  const visits = { count: vis, prev_count: pVis, bought: vOut["bought"] ?? 0, negotiating: vOut["negotiating"] ?? 0, left: vOut["left"] ?? 0, booking_to_visit: conversion["booking_to_visit"]?.rate ?? null, visit_to_sold: conversion["visit_to_sold"]?.rate ?? null };

  lap("appts");
  /* ── 成交/毛利（帳本；毛利只算成本知道的成交）── */
  const GP = "CASE WHEN status='sold' AND cost_source<>'none' THEN gross_profit ELSE 0 END";
  const dl = await db.first(`SELECT SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold, SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) AS lost,
      SUM(CASE WHEN status='sold' THEN sale_price ELSE 0 END) AS revenue, SUM(${GP}) AS gp,
      SUM(CASE WHEN status='sold' AND cost_source<>'none' THEN sale_price ELSE 0 END) AS revenue_known,
      SUM(CASE WHEN status='sold' AND cost_source<>'none' THEN 1 ELSE 0 END) AS gp_known, SUM(CASE WHEN status='sold' AND cost_source='none' THEN 1 ELSE 0 END) AS gp_unknown,
      SUM(CASE WHEN status='sold' AND gp_is_estimate=1 AND cost_source<>'none' THEN 1 ELSE 0 END) AS gp_est, SUM(CASE WHEN status='sold' AND source_kind='peer' THEN 1 ELSE 0 END) AS peer,
      SUM(CASE WHEN status='sold' AND cost_source<>'none' AND gross_profit < 0 THEN 1 ELSE 0 END) AS below FROM deals WHERE COALESCE(closed_at_source,'') <> 'import' AND closed_at >= ? AND closed_at < ?`, ...P);
  const pdl = await db.first(`SELECT SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold, SUM(CASE WHEN status='sold' THEN sale_price ELSE 0 END) AS revenue, SUM(${GP}) AS gp FROM deals WHERE COALESCE(closed_at_source,'') <> 'import' AND closed_at >= ? AND closed_at < ?`, ...Q);
  const sold = num(dl?.["sold"]), revenue = num(dl?.["revenue"]), gp = num(dl?.["gp"]), gpKnown = num(dl?.["gp_known"]);
  const rs = await db.first("SELECT COUNT(*) AS n, COALESCE(SUM(sale_price),0) AS amount FROM deals WHERE status = 'sold' AND delivered = 0 AND COALESCE(closed_at_source,'') <> 'import' AND closed_at >= ? AND closed_at < ?", ...P);   // 成交但還沒交車
  const sheetSold = num((await db.first("SELECT COUNT(*) AS n FROM deals WHERE status = 'sold' AND source_system = 'sheet' AND COALESCE(closed_at_source,'') <> 'import' AND closed_at >= ? AND closed_at < ?", ...P))?.["n"]);
  // 車源表第一次匯入就是售出／收訂的：成交日不明（表上沒有成交日），不算本期，另外列出來；之後兩份快照之間新出現的才有日期（介於兩次上傳之間）
  const und = await db.first("SELECT COUNT(*) AS n, COALESCE(SUM(sale_price),0) AS amount, COALESCE(SUM(CASE WHEN delivered = 0 THEN 1 ELSE 0 END),0) AS undelivered FROM deals WHERE status = 'sold' AND closed_at_source = 'import'");
  const sheetVanished = num((await db.first("SELECT COUNT(*) AS n FROM deals WHERE status = 'sold' AND source_system = 'sheet' AND sheet_status LIKE '車源表已移除%' AND COALESCE(closed_at_source,'') <> 'import' AND closed_at >= ? AND closed_at < ?", ...P))?.["n"]);
  const deals: Analytics["deals"] = {
    sold, lost: num(dl?.["lost"]), revenue, gross_profit: gp, avg_gp: gpKnown ? Math.round(gp / gpKnown) : null, gp_margin: rate(gp, num(dl?.["revenue_known"])), below_cost: num(dl?.["below"]),
    gp_known: gpKnown, gp_unknown: num(dl?.["gp_unknown"]), gp_estimate: num(dl?.["gp_est"]), peer_sold: num(dl?.["peer"]), revenue_known: num(dl?.["revenue_known"]),
    prev_sold: num(pdl?.["sold"]), prev_revenue: num(pdl?.["revenue"]), prev_gross_profit: num(pdl?.["gp"]),
    undelivered: num(rs?.["n"]), undelivered_amount: num(rs?.["amount"]), sheet_sold: sheetSold, sheet_vanished: sheetVanished,
    undated: { n: num(und?.["n"]), amount: num(und?.["amount"]), undelivered: num(und?.["undelivered"]) },
    lost_reasons: (await db.all(`SELECT lost_reason AS reason, COUNT(*) AS n FROM deals WHERE status='lost' AND COALESCE(closed_at_source,'') <> 'import' AND closed_at >= ? AND closed_at < ? GROUP BY lost_reason ORDER BY n DESC`, ...P)).map((r) => ({ reason: String(r["reason"] || "unknown"), n: num(r["n"]) })),
    by_staff: (await db.all(`SELECT COALESCE(u.name,'未指派') AS staff, COUNT(*) AS sold, SUM(d.sale_price) AS revenue, SUM(CASE WHEN d.cost_source<>'none' THEN d.gross_profit ELSE 0 END) AS gp, SUM(CASE WHEN d.cost_source='none' THEN 1 ELSE 0 END) AS unk FROM deals d LEFT JOIN users u ON u.id = d.staff_id WHERE d.status='sold' AND COALESCE(d.closed_at_source,'') <> 'import' AND d.closed_at >= ? AND d.closed_at < ? GROUP BY staff ORDER BY gp DESC`, ...P)).map((r) => ({ staff: String(r["staff"]), sold: num(r["sold"]), revenue: num(r["revenue"]), gross_profit: num(r["gp"]), gp_unknown: num(r["unk"]) })),
  };

  /* ── 業務（全期間，不只本週：跟進品質要看足夠樣本）── */
  // 員工列：以前每人 8 個子查詢、每個都掃「這個人的所有 lead 的事件」（未署名客服有 4 萬個 lead → 2 萬段時就要 5 秒）；改成三句 GROUP BY 再在 JS 對回去
  const byStaffEv = new Map<number, Record<string, number>>();
  for (const r of await db.all(`SELECT l.staff_id AS uid, e.type AS t, COUNT(*) AS n FROM funnel_events e JOIN leads l ON l.id = e.lead_id
      WHERE l.staff_id IS NOT NULL AND e.type IN ('PRICE_MENTIONED','PRICE_DROP_OFF','APPOINTMENT_BOOKED','FOLLOW_UP') AND (e.type <> 'PRICE_DROP_OFF' OR e.confidence <> 'UNCLEAR')
      GROUP BY l.staff_id, e.type`)) { const u = num(r["uid"]); if (!byStaffEv.has(u)) byStaffEv.set(u, {}); byStaffEv.get(u)![String(r["t"])] = num(r["n"]); }
  const byStaffLeads = new Map((await db.all("SELECT staff_id AS uid, COUNT(*) AS n FROM leads WHERE staff_id IS NOT NULL GROUP BY staff_id")).map((r) => [num(r["uid"]), num(r["n"])]));
  const byStaffDeals = new Map((await db.all("SELECT staff_id AS uid, COUNT(*) AS sold, COALESCE(SUM(sale_price),0) AS revenue, COALESCE(SUM(CASE WHEN cost_source<>'none' THEN gross_profit ELSE 0 END),0) AS gp FROM deals WHERE status='sold' AND staff_id IS NOT NULL GROUP BY staff_id")).map((r) => [num(r["uid"]), r]));
  const staffRows = (await db.all(`SELECT u.id, u.name, COALESCE(t.name,'') AS team FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.role = 'agent' OR u.job IN ('chat','sales','both')`))
    .map((u) => { const id = num(u["id"]), ev = byStaffEv.get(id) ?? {}, d = byStaffDeals.get(id);
      return { ...u, leads: byStaffLeads.get(id) ?? 0, priced: ev["PRICE_MENTIONED"] ?? 0, dropped: ev["PRICE_DROP_OFF"] ?? 0, booked: ev["APPOINTMENT_BOOKED"] ?? 0, followups: ev["FOLLOW_UP"] ?? 0, sold: num(d?.["sold"]), revenue: num(d?.["revenue"]), gp: num(d?.["gp"]) } as Row; })
    .sort((a, b) => num(b["gp"]) - num(a["gp"]));
  lap("staff_rows");
  // 首次回覆時間中位數：客戶第一則自己打的字（按選單不算）→ 該員第一則；超過 7 天才回的不算回覆（真資料有隔一年才回的，跟 behavior.ts 同一條規則）
  // 一次查全部再在 JS 分組（一人一句時 27 個員工 × 2 萬段對話要 10 秒）
  const latRows = await db.all(`
      SELECT cv.assigned_to AS uid, (julianday(s.created_at) - julianday(c.created_at)) * 1440 AS mins
        FROM conversations cv
        JOIN messages c ON c.id = (SELECT id FROM messages WHERE conversation_id = cv.id AND sender_role='customer' AND COALESCE(msg_type,'') <> 'menu' ORDER BY created_at LIMIT 1)
        JOIN messages s ON s.id = (SELECT id FROM messages WHERE conversation_id = cv.id AND sender_role='staff' AND created_at > c.created_at ORDER BY created_at LIMIT 1)
       WHERE cv.assigned_to IS NOT NULL AND (julianday(s.created_at) - julianday(c.created_at)) <= 7`);
  lap("latency");
  const latBy = new Map<number, number[]>();
  for (const x of latRows) { const u = num(x["uid"]); if (!latBy.has(u)) latBy.set(u, []); latBy.get(u)!.push(num(x["mins"])); }
  const staff: Analytics["staff"] = [];
  for (const r of staffRows) {
    const lat = (latBy.get(num(r["id"])) ?? []).sort((a, b) => a - b);
    const med = lat.length ? lat[Math.floor(lat.length / 2)]! : null;
    staff.push({ id: num(r["id"]), name: String(r["name"]), team: String(r["team"]), leads: num(r["leads"]), priced: num(r["priced"]), dropped: num(r["dropped"]), booked: num(r["booked"]), sold: num(r["sold"]), revenue: num(r["revenue"]), gross_profit: num(r["gp"]), median_first_response_min: med === null ? null : Math.round(med), followups: num(r["followups"]) });
  }

  lap("staff");
  /* ── 車款（全期間）── */
  const byVehEv = new Map<number, Record<string, number>>();
  for (const r of await db.all(`SELECT l.vehicle_id AS vid, e.type AS t, COUNT(*) AS n FROM funnel_events e JOIN leads l ON l.id = e.lead_id
      WHERE l.vehicle_id IS NOT NULL AND e.type IN ('PRICE_MENTIONED','PRICE_DROP_OFF','APPOINTMENT_BOOKED') AND (e.type <> 'PRICE_DROP_OFF' OR e.confidence <> 'UNCLEAR')
      GROUP BY l.vehicle_id, e.type`)) { const v = num(r["vid"]); if (!byVehEv.has(v)) byVehEv.set(v, {}); byVehEv.get(v)![String(r["t"])] = num(r["n"]); }
  const byVehLeads = new Map((await db.all("SELECT vehicle_id AS vid, COUNT(*) AS n FROM leads WHERE vehicle_id IS NOT NULL GROUP BY vehicle_id")).map((r) => [num(r["vid"]), num(r["n"])]));
  const byVehDeals = new Map((await db.all("SELECT vehicle_id AS vid, COUNT(*) AS sold, COALESCE(SUM(CASE WHEN cost_source<>'none' THEN gross_profit ELSE 0 END),0) AS gp FROM deals WHERE status='sold' AND vehicle_id IS NOT NULL GROUP BY vehicle_id")).map((r) => [num(r["vid"]), r]));
  const vehRows = (await db.all("SELECT v.id, v.brand || ' ' || v.model AS name, v.body_type, v.list_price, v.sell_price, v.cost, v.cost_known, v.stock_status FROM vehicles v"))
    .map((v) => { const id = num(v["id"]), ev = byVehEv.get(id) ?? {}, d = byVehDeals.get(id);
      return { ...v, inquiries: byVehLeads.get(id) ?? 0, priced: ev["PRICE_MENTIONED"] ?? 0, dropped: ev["PRICE_DROP_OFF"] ?? 0, booked: ev["APPOINTMENT_BOOKED"] ?? 0, sold: num(d?.["sold"]), gp: num(d?.["gp"]) } as Row; })
    .sort((a, b) => num(b["inquiries"]) - num(a["inquiries"]));
  const vehicles: Analytics["vehicles"] = vehRows
    .map((r) => ({ id: num(r["id"]), name: String(r["name"]), body_type: String(r["body_type"]), inquiries: num(r["inquiries"]), priced: num(r["priced"]), dropped: num(r["dropped"]), booked: num(r["booked"]), sold: num(r["sold"]), inquiry_to_sold: rate(num(r["sold"]), num(r["inquiries"])), gross_profit: num(r["gp"]),
      list_price: num(r["list_price"]), sell_price: r["sell_price"] == null ? null : num(r["sell_price"]), stock_status: String(r["stock_status"] ?? ""),
      // 在庫車的估算毛利＝調作價（實賣價）－成本；沒有調作價或沒有成本就不算，不拿開價硬算
      est_gp: r["sell_price"] != null && num(r["cost_known"]) ? num(r["sell_price"]) - num(r["cost"]) : null }));

  lap("vehicles");
  /* ── 需要注意（現在）── */
  const attention: Analytics["attention"] = [];
  const base = `SELECT l.id AS lead_id, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact, COALESCE(u.name,'未指派') AS staff, COALESCE(v.brand || ' ' || v.model,'') AS vehicle, {extra}
                  FROM leads l JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = l.staff_id LEFT JOIN vehicles v ON v.id = l.vehicle_id`;
  const openOnly = `l.outcome = '' AND NOT EXISTS (SELECT 1 FROM funnel_events z WHERE z.lead_id = l.id AND z.type IN ('SOLD','LOST') AND z.confidence <> 'POSSIBLE')`;
  const push = (kind: string, rows: Row[], reason: (r: Row) => string) => { for (const r of rows) attention.push({ kind, lead_id: num(r["lead_id"]), contact: String(r["contact"]), staff: String(r["staff"]), vehicle: String(r["vehicle"]), since: String(r["since"] ?? ""), reason: reason(r) }); };
  // 急迫：只看最近 14 天說急的（以前沒有窗口，二月的客戶也在今天的清單上）；分「沒人回」跟「回過但客戶沉默後沒再跟進」兩種話（2026-09-07 瑋瑋回饋）
  const B = (extra: string) => base.replace("{extra}", extra);
  push("high_intent_no_followup", await db.all(`${B("t.ls AS ls, t.lc AS lc, h.at AS since")} JOIN funnel_events h ON h.lead_id = l.id AND h.type='HIGH_INTENT'
      LEFT JOIN (SELECT lead_id, MAX(NULLIF(last_staff_at,'')) AS ls, MAX(NULLIF(last_customer_at,'')) AS lc FROM conversations WHERE lead_id IS NOT NULL GROUP BY lead_id) t ON t.lead_id = l.id
      WHERE ${openOnly} AND h.at >= ? AND NOT EXISTS (SELECT 1 FROM funnel_events f WHERE f.lead_id = l.id AND f.type='FOLLOW_UP' AND f.at > h.at)
        AND t.lc < ? AND (t.ls IS NULL OR t.ls < ?)
      ORDER BY h.at DESC LIMIT 10`, iso(toT - 14 * D), iso(toT - D), iso(toT - D)), (r) => (r["ls"] && String(r["ls"]) > String(r["lc"]) ? "客戶說急，業務回過，但客戶沉默超過 24 小時後沒有再跟進" : "客戶說急，超過 24 小時沒有人回"));
  push("price_dropoff_no_followup", await db.all(`${B("p.at AS since")} JOIN funnel_events p ON p.lead_id = l.id AND p.type='PRICE_DROP_OFF' AND p.confidence IN ('CONFIRMED','STRONGLY_SUGGESTED')
      WHERE ${openOnly} AND p.at >= ? AND NOT EXISTS (SELECT 1 FROM funnel_events f WHERE f.lead_id = l.id AND f.type='FOLLOW_UP' AND f.at > p.at)
      ORDER BY p.at DESC LIMIT 10`, iso(toT - 14 * D)), () => "報價後流失，兩週內沒有人再跟進");
  push("booked_but_no_visit", await db.all(`${B("a.scheduled_for AS since")} JOIN appointments a ON a.lead_id = l.id AND a.status='booked' AND a.scheduled_for < ?
      WHERE ${openOnly} AND NOT EXISTS (SELECT 1 FROM visits x WHERE x.lead_id = l.id) LIMIT 10`, iso(toT)), () => "預約時間已過，沒有到店也沒有標記爽約");
  // 貸款：只列「24 小時內沒有人回」的。以前列的是「沒給具體數字」，但抽樣 10 位業務全部幾分鐘內就回了（問哪台車、看條件）→ 叫「未回覆」不對（2026-09-07 瑋瑋回饋）
  push("financing_unresolved", await db.all(`${B("q.at AS since")} JOIN funnel_events q ON q.lead_id = l.id AND q.type='FINANCING_QUESTION' AND q.detail LIKE '%"reply_message_id":null%'
      WHERE ${openOnly} AND q.at >= ? AND q.at < ? LIMIT 10`, iso(toT - 14 * D), iso(toT - D)), () => "客戶問了貸款，24 小時內沒有人回");

  lap("attention");
  /* ── SABC（系統推算）：未結案客戶的現況、本期新進線的分布、結果標籤 ── */
  const gOpen: Record<string, number> = {}, gPeriod: Record<string, number> = {}, gTags: Record<string, number> = {};
  const activeSince = iso(toT - 30 * D);   // 「現況」只算近 30 天有訊息的未結案客戶，不然舊資料補進來全是幾萬個沉睡的 C
  for (const r of await db.all("SELECT l.grade_auto AS g, COUNT(*) AS n FROM leads l JOIN conversations cv ON cv.lead_id = l.id WHERE l.outcome = '' AND l.grade_auto <> '' AND cv.last_message_at >= ? GROUP BY l.grade_auto", activeSince)) gOpen[String(r["g"])] = num(r["n"]);
  for (const r of await db.all("SELECT grade_auto AS g, COUNT(*) AS n FROM leads WHERE opened_at >= ? AND opened_at < ? AND grade_auto <> '' GROUP BY grade_auto", ...P)) gPeriod[String(r["g"])] = num(r["n"]);
  for (const r of await db.all("SELECT l.result_tag AS t, COUNT(*) AS n FROM leads l JOIN conversations cv ON cv.lead_id = l.id WHERE l.outcome = '' AND l.result_tag <> '' AND cv.last_message_at >= ? GROUP BY l.result_tag", activeSince)) for (const t of String(r["t"]).split("、")) if (t) gTags[t] = (gTags[t] ?? 0) + num(r["n"]);
  const grades: Analytics["grades"] = { open: gOpen, period: gPeriod, long_cycle: gTags["長週期"] ?? 0, tags: gTags };
  lap("grades");
  return { period, prev, funnel: { events, prev_events, leads, prev_leads, typed_leads, prev_typed_leads, stages }, conversion, price_dropoff, appointments, visits, deals, staff, vehicles, attention, grades, timings };
}
