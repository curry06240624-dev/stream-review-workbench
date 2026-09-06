/**
 * 配對引擎 —— 成交群「送貨囉」貼文 → 車源表的車 → 客戶（lead）→ 業務 → 成交帳本；接待群貼文 → 到店；估車群貼文 → 估車紀錄。
 *
 * 規則（docs/DATA_FLOW.md §配對）：
 *   車    車牌相同（確定）＞ 年份＋車型＋顏色只對到一台（強烈建議）＞ 多台（可能，列候選）＞ 用客戶正在談的那台（強烈建議）
 *   客戶  貼文有客戶名（確定）＞ 同一台車近期有到店／議價的客戶只有一位（強烈建議）＞ 接待群 ±14 天同車款（可能）
 *   業務  lead 指派的業務 ＞ 接待群指派 ＞ 貼文寫的業務 ＞ 發文人本身是業務（可能）
 *   有售價、車與客戶都有、其中一個是「確定」、另一個至少「強烈建議」→ 自動配對（老闆可撤銷）；有候選 → 待確認；沒有 → 無法配對
 * 毛利：庫存車＋車源表有成本 → 估算毛利（gp_is_estimate=1）；同行車或沒成本 → 不算（cost_source='none'）。正式毛利以會計為準。
 * 每一步的理由都寫進 match_reasons，畫面照抄，不另外解釋。
 */
import type { DbLike } from "../adapters/import.ts";
import { parseDealReport, parseAppraisal, parseReception, detectKind, hashId, modelLike, colorKey, type Post } from "./posts.ts";
import { runFunnel } from "./funnel.ts";
import { computeRoles } from "./attribution.ts";

type Row = Record<string, unknown>;
const H = 3_600_000, D = 24 * H;
const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => String(v ?? "");
const jsonOf = <T,>(v: unknown, fallback: T): T => { try { return JSON.parse(str(v) || "null") ?? fallback; } catch { return fallback; } };

export interface IngestReport {
  posts: number; deal_reports: number; visits: number; appraisals: number; auto: number; suggested: number; unmatched: number; duplicates: number;
  unparsed: Array<{ at: string; sender: string; text: string }>; unmatched_posts: Array<{ kind: string; text: string; note: string }>; warnings: string[];
}
interface Cand { id: number; label: string; reason: string }
interface Cands { vehicles: Cand[]; leads: Cand[]; applied?: Row }

/** 名字 → user id：本名或任何系統的暱稱；去掉 emoji 與空白再比 */
const nameKey = (s: string) => s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, "").trim();
export async function staffResolver(db: DbLike) {
  const users = await db.all("SELECT id, name, role, job FROM users");
  const aliases = await db.all("SELECT user_id, alias FROM staff_aliases");
  const map = new Map<string, number>();
  for (const u of users) map.set(nameKey(str(u["name"])), num(u["id"]));
  for (const a of aliases) map.set(nameKey(str(a["alias"])), num(a["user_id"]));
  const jobOf = new Map(users.map((u) => [num(u["id"]), str(u["job"]) || (str(u["role"]) === "agent" ? "both" : "manager")]));
  return {
    resolve: (name: string | null | undefined): number | null => (name ? map.get(nameKey(name)) ?? null : null),
    jobOf: (id: number) => jobOf.get(id) ?? "",
  };
}

/** 客戶名 → contact：先全同（顯示名或化名），再包含；兩個以上就不猜 */
async function findContact(db: DbLike, ref: string): Promise<{ row: Row | null; note: string }> {
  const r = ref.trim(); if (!r) return { row: null, note: "" };
  const exact = await db.first("SELECT id, display_name, pseudonym FROM contacts WHERE display_name = ? OR pseudonym = ? ORDER BY id DESC LIMIT 1", r, r);
  if (exact) return { row: exact, note: "" };
  if (r.length < 2) return { row: null, note: `客戶名「${r}」太短，不猜` };
  const like = await db.all("SELECT id, display_name, pseudonym FROM contacts WHERE display_name LIKE ? ORDER BY id DESC LIMIT 3", `%${r}%`);
  if (like.length === 1) return { row: like[0]!, note: `客戶名「${r}」包含比對到 ${str(like[0]!["display_name"])}` };
  if (like.length > 1) return { row: null, note: `客戶名「${r}」對到 ${like.length} 位，要人選` };
  return { row: null, note: `找不到客戶「${r}」` };
}
async function latestLead(db: DbLike, contactId: number): Promise<Row | null> {
  return db.first("SELECT * FROM leads WHERE contact_id = ? ORDER BY CASE WHEN outcome = '' THEN 0 ELSE 1 END, opened_at DESC LIMIT 1", contactId);
}
const vehicleLabel = (v: Row) => `${str(v["year"]) ? str(v["year"]) + " " : ""}${str(v["brand"])} ${str(v["model"])}${str(v["color"]) ? " · " + str(v["color"]) : ""}${str(v["plate"]) ? " · " + str(v["plate"]) : ""}`.trim();

/* ── 配對一則送貨囉 ── */
export async function matchReport(db: DbLike, id: number, now: string): Promise<void> {
  const r = await db.first("SELECT * FROM deal_reports WHERE id = ?", id); if (!r) return;
  const status0 = str(r["match_status"]); if (status0 === "confirmed" || status0 === "rejected") return;
  const at = str(r["reported_at"]), atT = Date.parse(at);
  const plate = str(r["plate"]), plateNorm = str(r["plate_norm"]), model = str(r["model_text"]), year = r["year"] == null ? null : num(r["year"]), color = str(r["color"]);
  const customerRef = str(r["customer_ref"]), staffRef = str(r["staff_ref"]), reportedBy = str(r["reported_by"]);
  const isPeer = str(r["source_kind"]) === "peer";
  const reasons: string[] = []; const cands: Cands = { vehicles: [], leads: [] };
  let vehicle: Row | null = null, vConf = "", lead: Row | null = null, lConf = "", staffId: number | null = null, method = "";

  /* 車 */
  if (plateNorm) {
    const v = await db.first("SELECT * FROM vehicles WHERE plate_norm = ? ORDER BY id DESC LIMIT 1", plateNorm);
    if (v) { vehicle = v; vConf = "CONFIRMED"; method = "plate"; reasons.push(`車牌相同（${plate}）→ ${vehicleLabel(v)}`); cands.vehicles.push({ id: num(v["id"]), label: vehicleLabel(v), reason: "車牌相同" }); }
    else reasons.push(`車源表沒有車牌 ${plate}${isPeer ? "（同行的車通常不在車源表）" : ""}`);
  } else reasons.push("貼文的車號空白");
  if (!vehicle && model && isPeer) reasons.push("同行的車不在車源表，不用年份車型猜（只認車牌），成本也不算");
  if (!vehicle && model && !isPeer) {
    const all = await db.all("SELECT * FROM vehicles");
    const scored = all.map((v) => {
      if (!modelLike(model, `${str(v["brand"])} ${str(v["model"])}`) && !modelLike(model, str(v["model"]))) return null;
      let score = 1; const why: string[] = ["車型相同"];
      if (year != null && v["year"] != null) { if (num(v["year"]) !== year) return null; score++; why.push("年份相同"); }
      if (color && str(v["color"])) { if (colorKey(color) !== colorKey(str(v["color"]))) return null; score++; why.push("顏色相同"); }
      if (["in_stock", "reserved"].includes(str(v["stock_status"]))) score++;
      return { v, score, why };
    }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.score - a.score);
    const top = scored.filter((x) => x.score === scored[0]?.score);
    for (const x of scored.slice(0, 5)) cands.vehicles.push({ id: num(x.v["id"]), label: vehicleLabel(x.v), reason: x.why.join("、") });
    if (top.length === 1 && top[0]!.score >= 2) { vehicle = top[0]!.v; vConf = "STRONGLY_SUGGESTED"; method = "fuzzy"; reasons.push(`${top[0]!.why.join("、")}，車源表只對到一台：${vehicleLabel(vehicle)}`); }
    else if (top.length > 1) { vConf = "POSSIBLE"; reasons.push(`${top[0]!.why.join("、")}的車有 ${top.length} 台，要人選`); }
    else if (!scored.length) reasons.push(`車源表找不到「${year ?? ""} ${model} ${color}」相符的車${isPeer ? "（同行的車）" : ""}`);
  }

  /* 客戶 */
  if (customerRef) {
    const c = await findContact(db, customerRef);
    if (c.note) reasons.push(c.note);
    if (c.row) { const l = await latestLead(db, num(c.row["id"])); if (l) { lead = l; lConf = "CONFIRMED"; method = method || "customer"; reasons.push(`貼文寫了客戶「${customerRef}」→ ${str(c.row["pseudonym"]) || str(c.row["display_name"])}`); cands.leads.push({ id: num(l["id"]), label: str(c.row["pseudonym"]) || str(c.row["display_name"]), reason: "貼文寫了客戶名" }); } }
  }
  if (!lead && vehicle) {
    const rows = await db.all(
      `SELECT l.*, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact,
              (SELECT MAX(m.created_at) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.lead_id = l.id) AS last_at,
              EXISTS (SELECT 1 FROM funnel_events e WHERE e.lead_id = l.id AND e.type IN ('STORE_VISIT','NEGOTIATION') AND e.confidence <> 'UNCLEAR') AS hot,
              (SELECT MIN(d.closed_at) FROM deals d WHERE d.lead_id = l.id AND d.status = 'sold') AS sold_at
         FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.vehicle_id = ? AND l.outcome <> 'lost' AND l.opened_at <= ?`, num(vehicle["id"]), new Date(atT + 3 * D).toISOString());
    const scored = rows.map((l) => {
      let score = 0; const why: string[] = ["同一台車"]; let dist = Infinity;
      if (num(l["hot"])) { score += 2; why.push("有到店或議價"); }
      const lastAt = l["last_at"] ? Date.parse(str(l["last_at"])) : 0;
      if (lastAt && lastAt >= atT - 45 * D && lastAt <= atT + 3 * D) { score += 1; why.push("近 45 天有往來"); }
      const soldAt = l["sold_at"] ? Date.parse(str(l["sold_at"])) : 0;
      if (soldAt) { dist = Math.abs(soldAt - atT); if (dist <= 12 * H) { score += 4; why.push("帳本同一天已有成交"); } else if (dist <= 3 * D) { score += 2; why.push("帳本三天內有成交"); } }
      return { l, score, why, dist };
    }).filter((x) => x.score >= 1).sort((a, b) => b.score - a.score || a.dist - b.dist);
    const top = scored.filter((x) => x.score === scored[0]?.score);
    for (const x of scored.slice(0, 5)) cands.leads.push({ id: num(x.l["id"]), label: str(x.l["contact"]), reason: x.why.join("、") });
    /* 同分時，帳本成交時間離貼文最近的那位勝出（其他人要至少晚 6 小時才算明顯） */
    const one = top.length === 1 ? top[0]! : (top.length > 1 && top[0]!.dist < Infinity && top[1]!.dist - top[0]!.dist >= 6 * H ? top[0]! : null);
    if (one) { lead = one.l; lConf = one.score >= 4 ? "CONFIRMED" : "STRONGLY_SUGGESTED"; reasons.push(`這台車${one.why.slice(1).join("、")}的客戶${top.length > 1 ? "中，成交時間最接近貼文的" : "只有"}一位：${str(lead["contact"])}`); }
    else if (top.length > 1) { lConf = "POSSIBLE"; reasons.push(`這台車有 ${top.length} 位客戶在談，要人選`); }
    else reasons.push("這台車沒有正在談的客戶");
  }
  if (!lead && !vehicle && model) {
    const vs = await db.all(
      `SELECT vi.lead_id, vi.model_text, vi.visited_at, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact, COALESCE(v.brand||' '||v.model,'') AS lead_vehicle
         FROM visits vi JOIN leads l ON l.id = vi.lead_id JOIN contacts c ON c.id = l.contact_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
        WHERE vi.source = 'reception' AND vi.visited_at >= ? AND vi.visited_at <= ? AND l.outcome <> 'lost'`, new Date(atT - 14 * D).toISOString(), new Date(atT + D).toISOString());
    const hits = vs.filter((x) => modelLike(model, str(x["model_text"])) || modelLike(model, str(x["lead_vehicle"])));
    for (const x of hits.slice(0, 5)) cands.leads.push({ id: num(x["lead_id"]), label: str(x["contact"]), reason: `接待群 ${str(x["visited_at"]).slice(5, 10)} 到店看 ${str(x["model_text"]) || str(x["lead_vehicle"])}` });
    if (hits.length === 1) { lead = await db.first("SELECT * FROM leads WHERE id = ?", num(hits[0]!["lead_id"])); lConf = "POSSIBLE"; reasons.push(`接待群 ±14 天內看同車款的客戶只有一位：${str(hits[0]!["contact"])}`); }
    else if (hits.length > 1) { lConf = "POSSIBLE"; reasons.push(`接待群 ±14 天內有 ${hits.length} 位客戶看同車款，要人選`); }
  }
  /* 客戶有、車沒有 → 用客戶正在談的那台（同行的車不這樣猜） */
  if (lead && !vehicle && lead["vehicle_id"] && !isPeer) {
    const v = await db.first("SELECT * FROM vehicles WHERE id = ?", num(lead["vehicle_id"]));
    if (v && (!model || modelLike(model, `${str(v["brand"])} ${str(v["model"])}`) || modelLike(model, str(v["model"])))) { vehicle = v; vConf = "STRONGLY_SUGGESTED"; reasons.push(`用這位客戶正在談的車：${vehicleLabel(v)}`); if (!cands.vehicles.some((c) => c.id === num(v["id"]))) cands.vehicles.unshift({ id: num(v["id"]), label: vehicleLabel(v), reason: "客戶正在談的車" }); }
  }

  /* 業務 */
  const res = await staffResolver(db);
  if (lead && lead["staff_id"]) { staffId = num(lead["staff_id"]); reasons.push("業務＝這位客戶指派的業務"); }
  else if (lead) { const v = await db.first("SELECT staff_id FROM visits WHERE lead_id = ? AND staff_id IS NOT NULL ORDER BY visited_at DESC LIMIT 1", num(lead["id"])); if (v) { staffId = num(v["staff_id"]); reasons.push("業務＝接待群指派"); } }
  if (!staffId && staffRef) { staffId = res.resolve(staffRef); reasons.push(staffId ? `貼文寫了業務「${staffRef}」` : `貼文寫的業務「${staffRef}」對不到員工（暱稱表要補）`); }
  if (!staffId && reportedBy) { const u = res.resolve(reportedBy); if (u && ["sales", "both"].includes(res.jobOf(u))) { staffId = u; reasons.push(`發文人 ${reportedBy} 本身是業務（可能）`); } }
  const reportedByUid = res.resolve(reportedBy);
  if (reportedBy && !reportedByUid) reasons.push(`發文人「${reportedBy}」對不到員工（暱稱表要補）`);

  /* 狀態 */
  const hasPrice = r["sale_price"] != null && num(r["sale_price"]) > 0;
  const strong = (c: string) => c === "CONFIRMED" || c === "STRONGLY_SUGGESTED";
  let status: "auto" | "suggested" | "unmatched";
  if (hasPrice && lead && vehicle && (vConf === "CONFIRMED" || lConf === "CONFIRMED") && strong(vConf) && strong(lConf)) status = "auto";
  else if (hasPrice && lead && lConf === "CONFIRMED" && !vehicle && isPeer) status = "auto";      // 同行車：客戶名確定就夠，車本來就不在表裡
  else if (vehicle || lead || cands.vehicles.length || cands.leads.length) status = "suggested";
  else status = "unmatched";
  if (!hasPrice) reasons.push("貼文沒有售價，不能自動建立成交");
  const order = ["CONFIRMED", "STRONGLY_SUGGESTED", "POSSIBLE", ""];
  const conf = [vConf, lConf].filter(Boolean).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? "";
  await db.run(
    `UPDATE deal_reports SET match_status = ?, match_method = ?, match_confidence = ?, match_reasons = ?, candidates = ?, vehicle_id = ?, lead_id = ?, contact_id = ?, staff_id = ?, reported_by_user_id = ? WHERE id = ?`,
    status, method, conf, JSON.stringify(reasons), JSON.stringify(cands), vehicle ? num(vehicle["id"]) : null, lead ? num(lead["id"]) : null, lead ? num(lead["contact_id"]) : null, staffId, reportedByUid, id);
  if (status === "auto") await applyReport(db, id, {}, null, now, "auto");
}

/** 套用配對：建立或連結成交帳本、關閉 lead、車標已售；auto 與 confirmed 共用 */
export async function applyReport(db: DbLike, id: number, ov: { vehicle_id?: number | null; lead_id?: number | null; staff_id?: number | null }, by: number | null, now: string, status: "auto" | "confirmed"): Promise<{ deal_id: number; created: boolean }> {
  const r = await db.first("SELECT * FROM deal_reports WHERE id = ?", id); if (!r) throw new Error("找不到這則貼文");
  const vehicleId = ov.vehicle_id !== undefined ? ov.vehicle_id : (r["vehicle_id"] == null ? null : num(r["vehicle_id"]));
  const leadId = ov.lead_id !== undefined ? ov.lead_id : (r["lead_id"] == null ? null : num(r["lead_id"]));
  let staffId = ov.staff_id !== undefined ? ov.staff_id : (r["staff_id"] == null ? null : num(r["staff_id"]));
  if (!leadId) throw new Error("要先對到客戶才能建立成交");
  const lead = await db.first("SELECT * FROM leads WHERE id = ?", leadId); if (!lead) throw new Error("找不到這位客戶的旅程");
  const price = num(r["sale_price"]); if (!price) throw new Error("貼文沒有售價");
  if (!staffId) staffId = lead["staff_id"] == null ? null : num(lead["staff_id"]);
  const v = vehicleId ? await db.first("SELECT * FROM vehicles WHERE id = ?", vehicleId) : null;
  const peer = str(r["source_kind"]) === "peer" || (!!v && str(v["source"]) === "peer");
  let cost = 0, costSource = "none", gp = 0, est = 0;
  if (v && num(v["cost_known"]) && !peer) { cost = num(v["cost"]); costSource = "sheet"; gp = price - cost; est = 1; }
  const applied = { lead_prev_outcome: str(lead["outcome"]), lead_prev_closed_at: lead["closed_at"] ?? null, lead_prev_stage: str(lead["stage"]), vehicle_prev_status: v ? str(v["stock_status"]) : null, sheet_deal: null as Row | null };
  const existing = await db.first("SELECT * FROM deals WHERE lead_id = ? AND status = 'sold' ORDER BY id LIMIT 1", leadId);
  // 車源表先產生的成交／收訂（沒有客戶）對到同一台車 → 換成貼文的成交；原列存進快照，撤銷時放回去
  if (!existing && vehicleId) {
    const sd = await db.first("SELECT * FROM deals WHERE vehicle_id = ? AND source_system = 'sheet' AND status = 'sold' ORDER BY id LIMIT 1", vehicleId);
    if (sd) { applied.sheet_deal = sd; await db.run("DELETE FROM deals WHERE id = ?", num(sd["id"])); }
  }
  let dealId: number, created = 0;
  if (existing) {
    dealId = num(existing["id"]);
    await db.run(`UPDATE deals SET plate = ?, customer_ref = ?, deposit = ?, loan_status = ?, delivery_by = ?, reported_by = ?, source_kind = ?, peer_dealer = ?, report_id = ?,
                    vehicle_id = COALESCE(vehicle_id, ?), staff_id = COALESCE(staff_id, ?) WHERE id = ?`,
      str(r["plate"]), str(r["customer_ref"]), str(r["deposit"]), str(r["loan_status"]), str(r["delivery_by"]), str(r["reported_by"]), str(r["source_kind"]) || "stock", str(r["peer_dealer"]), id, vehicleId, staffId, dealId);
  } else {
    const ins = await db.run(
      `INSERT INTO deals (lead_id, contact_id, staff_id, vehicle_id, status, sale_price, cost, gross_profit, lost_reason, closed_at, external_key, source_system,
                          plate, customer_ref, deposit, loan_status, delivery_by, reported_by, source_kind, peer_dealer, cost_source, gp_is_estimate, report_id, price_source)
       VALUES (?,?,?,?,'sold',?,?,?,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?,'report')`,
      leadId, num(lead["contact_id"]), staffId, vehicleId, price, cost, gp, str(r["reported_at"]), `report:${id}`, str(r["source_system"]),
      str(r["plate"]), str(r["customer_ref"]), str(r["deposit"]), str(r["loan_status"]), str(r["delivery_by"]), str(r["reported_by"]), str(r["source_kind"]) || "stock", str(r["peer_dealer"]), costSource, est, id);
    dealId = ins.lastRowId; created = 1;
    await db.run("UPDATE leads SET outcome = 'sold', closed_at = ?, stage = 'closed' WHERE id = ?", str(r["reported_at"]), leadId);
    await db.run("UPDATE conversations SET status = 'closed' WHERE lead_id = ?", leadId);
    await db.run("DELETE FROM evidence WHERE loss_id IN (SELECT id FROM loss_analyses WHERE lead_id = ?)", leadId);
    await db.run("DELETE FROM loss_analyses WHERE lead_id = ?", leadId);
    if (v && !peer) await db.run("UPDATE vehicles SET stock_status = 'sold' WHERE id = ?", vehicleId);
  }
  const cands = jsonOf<Cands>(r["candidates"], { vehicles: [], leads: [] }); cands.applied = applied;
  await db.run(`UPDATE deal_reports SET match_status = ?, vehicle_id = ?, lead_id = ?, contact_id = ?, staff_id = ?, deal_id = ?, deal_created = ?, candidates = ?, confirmed_by = ?, confirmed_at = ?,
                  match_method = CASE WHEN ? = 1 THEN 'manual' ELSE match_method END WHERE id = ?`,
    status, vehicleId, leadId, num(lead["contact_id"]), staffId, dealId, created, JSON.stringify(cands), by, status === "confirmed" ? now : null, ov.vehicle_id !== undefined || ov.lead_id !== undefined || ov.staff_id !== undefined ? 1 : 0, id);
  await runFunnel(db, { now, leadIds: [leadId] });
  await computeRoles(db, { leadIds: [leadId] });
  return { deal_id: dealId, created: !!created };
}

/** 撤銷／拒絕：把自動或人工配對造成的成交拿掉，lead 與車還原 */
export async function unapplyReport(db: DbLike, id: number, next: "suggested" | "rejected", by: number | null, now: string): Promise<void> {
  const r = await db.first("SELECT * FROM deal_reports WHERE id = ?", id); if (!r) throw new Error("找不到這則貼文");
  const cands = jsonOf<Cands>(r["candidates"], { vehicles: [], leads: [] }); const applied = cands.applied ?? null;
  const leadId = r["lead_id"] == null ? null : num(r["lead_id"]);
  if (r["deal_id"]) {
    if (num(r["deal_created"])) {
      await db.run("DELETE FROM deals WHERE id = ?", num(r["deal_id"]));
      const sd = applied?.["sheet_deal"] as Row | null | undefined;   // 車源表那筆放回去
      if (sd) { const cols = Object.keys(sd).filter((k) => k !== "id"); await db.run(`INSERT INTO deals (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`, ...cols.map((k) => sd[k])); }
      if (leadId && applied) {
        await db.run("UPDATE leads SET outcome = ?, closed_at = ?, stage = ? WHERE id = ?", str(applied["lead_prev_outcome"]), applied["lead_prev_closed_at"] ?? null, str(applied["lead_prev_stage"]) || "new", leadId);
        await db.run("UPDATE conversations SET status = ? WHERE lead_id = ?", str(applied["lead_prev_outcome"]) ? "closed" : "open", leadId);
      }
      if (r["vehicle_id"] && applied && applied["vehicle_prev_status"]) await db.run("UPDATE vehicles SET stock_status = ? WHERE id = ?", str(applied["vehicle_prev_status"]), num(r["vehicle_id"]));
    } else await db.run("UPDATE deals SET report_id = NULL WHERE id = ?", num(r["deal_id"]));
  }
  delete cands.applied;
  await db.run("UPDATE deal_reports SET match_status = ?, deal_id = NULL, deal_created = 0, candidates = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?", next, JSON.stringify(cands), by, next === "rejected" ? now : null, id);
  if (leadId) { await runFunnel(db, { now, leadIds: [leadId] }); await computeRoles(db, { leadIds: [leadId] }); }
}

/* ── 匯入群組貼文（LINE 匯出檔、或 bundle 裡的原文）── */
export async function ingestPosts(db: DbLike, posts: Post[], opts: { kind: "deal" | "reception" | "appraisal" | "auto"; source_system: string; now: string }): Promise<IngestReport> {
  const rep: IngestReport = { posts: posts.length, deal_reports: 0, visits: 0, appraisals: 0, auto: 0, suggested: 0, unmatched: 0, duplicates: 0, unparsed: [], unmatched_posts: [], warnings: [] };
  const res = await staffResolver(db);
  const src = opts.source_system;
  for (const p of posts) {
    const ext = hashId(`${p.at}|${p.sender}|${p.text}`);
    const kind = opts.kind === "auto" ? detectKind(p.text) : opts.kind;
    const dup = await db.first("SELECT id FROM group_posts WHERE source_system = ? AND external_id = ?", src, ext);
    if (dup) { rep.duplicates++; continue; }
    const gp = await db.run("INSERT INTO group_posts (kind, at, sender, text, status, source_system, external_id, created_at) VALUES (?,?,?,?,?,?,?,?)", kind, p.at, p.sender, p.text, "ignored", src, ext, opts.now);
    const setPost = (status: string, refTable: string, refId: number | null, note = "") => db.run("UPDATE group_posts SET status = ?, ref_table = ?, ref_id = ?, note = ? WHERE id = ?", status, refTable, refId, note, gp.lastRowId);
    if (kind === "deal") {
      const d = parseDealReport(p.text);
      if (!d) { rep.unparsed.push(p); await setPost("ignored", "", null, "看起來是成交群貼文但解析不出欄位"); continue; }
      const ins = await db.run(
        `INSERT OR IGNORE INTO deal_reports (reported_at, reported_by, year, model_text, color, plate, plate_norm, deposit, sale_price, source_kind, peer_dealer, delivery_by, delivery_uncertain, note, loan_status, customer_ref, staff_ref, raw_text, missing, source_system, external_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.at, p.sender, d.year, d.model_text, d.color, d.plate, d.plate_norm, d.deposit, d.sale_price, d.source_kind, d.peer_dealer, d.delivery_by, d.delivery_uncertain ? 1 : 0, d.note, d.loan_status, d.customer_ref, d.staff_ref, p.text, JSON.stringify(d.missing), src, ext, opts.now);
      if (!ins.lastRowId) { rep.duplicates++; continue; }
      rep.deal_reports++;
      await matchReport(db, ins.lastRowId, opts.now);
      const st = str((await db.first("SELECT match_status FROM deal_reports WHERE id = ?", ins.lastRowId))?.["match_status"]);
      if (st === "auto") rep.auto++; else if (st === "suggested") rep.suggested++; else rep.unmatched++;
      await setPost("parsed", "deal_reports", ins.lastRowId, st);
    } else if (kind === "reception") {
      const rc = parseReception(p.text, p.at);
      if (!rc) { rep.unparsed.push(p); await setPost("ignored", "", null, "解析不出客戶名／車款／到店時間"); continue; }
      const c = await findContact(db, rc.customer_ref);
      const lead = c.row ? await latestLead(db, num(c.row["id"])) : null;
      if (!lead) { const note = c.note || `找不到客戶「${rc.customer_ref}」`; rep.unmatched_posts.push({ kind, text: p.text, note }); await setPost("unmatched", "", null, note); continue; }
      const staffId = res.resolve(rc.assigned_name);
      const visitedAt = rc.visited_at ?? p.at;
      const vi = await db.run(`INSERT INTO visits (lead_id, appointment_id, staff_id, visited_at, outcome, note, source, customer_ref, model_text, assigned_by, raw_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        num(lead["id"]), null, staffId, visitedAt, "", "", "reception", rc.customer_ref, rc.model_text, p.sender, p.text);
      rep.visits++;
      if (staffId && !lead["staff_id"]) {
        await db.run("UPDATE leads SET staff_id = ? WHERE id = ?", staffId, num(lead["id"]));
        const cv = await db.first("SELECT id FROM conversations WHERE lead_id = ? ORDER BY id LIMIT 1", num(lead["id"]));
        if (cv) await db.run("INSERT INTO assignment_log (conversation_id, from_user_id, to_user_id, by_user_id, created_at) VALUES (?,?,?,?,?)", num(cv["id"]), null, staffId, res.resolve(p.sender) ?? staffId, visitedAt);
      } else if (rc.assigned_name && !staffId) rep.warnings.push(`接待群指派的「${rc.assigned_name}」對不到員工（暱稱表要補）`);
      await setPost("parsed", "visits", vi.lastRowId, c.note);
      await runFunnel(db, { now: opts.now, leadIds: [num(lead["id"])] });
    } else if (kind === "appraisal") {
      const a = parseAppraisal(p.text);
      if (!a) { rep.unparsed.push(p); await setPost("ignored", "", null, "解析不出估車欄位"); continue; }
      const c = a.customer_ref ? await findContact(db, a.customer_ref) : { row: null, note: "貼文沒有客戶名" };
      const lead = c.row ? await latestLead(db, num(c.row["id"])) : null;
      const ins = await db.run(
        `INSERT OR IGNORE INTO appraisals (reported_at, reported_by, reported_by_user_id, model_text, year, trim, color, mileage_km, book_quanwei, book_tianshu, mode, customer_ask, customer_ref, lead_id, contact_id, raw_text, source_system, external_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.at, p.sender, res.resolve(p.sender), a.model_text, a.year, a.trim, a.color, a.mileage_km, a.book_quanwei, a.book_tianshu, a.mode, a.customer_ask, a.customer_ref, lead ? num(lead["id"]) : null, c.row ? num(c.row["id"]) : null, p.text, src, ext, opts.now);
      if (!ins.lastRowId) { rep.duplicates++; continue; }
      rep.appraisals++;
      await setPost(lead ? "parsed" : "unmatched", "appraisals", ins.lastRowId, c.note);
      if (!lead) rep.unmatched_posts.push({ kind, text: p.text, note: c.note });
    } else {
      rep.unparsed.push(p); await setPost("ignored", "", null, "看不出是哪一種貼文");
    }
  }
  return rep;
}

/* ── 畫面用的總覽 ── */
export async function reconcileSummary(db: DbLike, opts: { status?: string; days?: number }) {
  const days = opts.days ?? 30; const fromT = Date.now() - days * D;
  const where = opts.status ? "WHERE r.match_status = ?" : "";
  const rows = await db.all(
    `SELECT r.*, COALESCE(v.brand||' '||v.model,'') AS vehicle_label, v.plate AS vehicle_plate, v.color AS vehicle_color, v.year AS vehicle_year, v.cost_known, v.source AS vehicle_source, v.cost AS vehicle_cost,
            COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact, c.display_name AS contact_display, u.name AS staff_name, ru.name AS reported_by_name, l.outcome AS lead_outcome, l.stage AS lead_stage,
            d.gross_profit AS deal_gp, d.cost_source AS deal_cost_source
       FROM deal_reports r LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN contacts c ON c.id = r.contact_id LEFT JOIN users u ON u.id = r.staff_id
       LEFT JOIN users ru ON ru.id = r.reported_by_user_id LEFT JOIN leads l ON l.id = r.lead_id LEFT JOIN deals d ON d.id = r.deal_id
       ${where} ORDER BY CASE r.match_status WHEN 'suggested' THEN 0 WHEN 'unmatched' THEN 1 WHEN 'auto' THEN 2 WHEN 'confirmed' THEN 3 ELSE 4 END, r.reported_at DESC LIMIT 200`, ...(opts.status ? [opts.status] : []));
  const counts = Object.fromEntries((await db.all("SELECT match_status, COUNT(*) AS n, COALESCE(SUM(sale_price),0) AS amount FROM deal_reports GROUP BY match_status")).map((r) => [str(r["match_status"]), { n: num(r["n"]), amount: num(r["amount"]) }]));
  const recent = await db.first("SELECT COUNT(*) AS n, COALESCE(SUM(sale_price),0) AS amount FROM deal_reports WHERE reported_at >= ?", new Date(fromT).toISOString());
  const missingTally: Record<string, number> = {};
  for (const r of rows) for (const m of jsonOf<string[]>(r["missing"], [])) missingTally[m] = (missingTally[m] ?? 0) + 1;
  const dealsNoCost = num((await db.first("SELECT COUNT(*) AS n FROM deals WHERE status = 'sold' AND cost_source = 'none'"))?.["n"]);
  const dealsEstimate = num((await db.first("SELECT COUNT(*) AS n FROM deals WHERE status = 'sold' AND gp_is_estimate = 1"))?.["n"]);
  const unmatchedPosts = await db.all("SELECT id, kind, at, sender, text, note FROM group_posts WHERE status = 'unmatched' ORDER BY at DESC LIMIT 40");
  const unparsedPosts = await db.all("SELECT id, kind, at, sender, text, note FROM group_posts WHERE status = 'ignored' ORDER BY at DESC LIMIT 20");
  const shape = (r: Row) => ({ ...r, missing: jsonOf<string[]>(r["missing"], []), match_reasons: jsonOf<string[]>(r["match_reasons"], []), candidates: jsonOf<Cands>(r["candidates"], { vehicles: [], leads: [] }) });
  return { counts, recent: { days, n: num(recent?.["n"]), amount: num(recent?.["amount"]) }, missing: missingTally, deals_no_cost: dealsNoCost, deals_estimate: dealsEstimate, rows: rows.map(shape), unmatched_posts: unmatchedPosts, unparsed_posts: unparsedPosts };
}
