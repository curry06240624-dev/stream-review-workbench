/**
 * 車源表 → 成交。
 *
 * 瑋瑋公司的車源表「目前狀況」會寫 收訂(軒)／送貸(軒)／過件(安)，備註寫「售出 銷售獎金5000」。
 * 成交群的送貨囉貼文常常晚到、車號又常空白，所以帳上的成交先以車源表為準。
 * Curry 2026-09-06：**收訂就算成交**（訂金已收、貸款送件或過件都是賣掉了，只是還沒交車）：
 *   - 收訂／送貸／過件（vehicles.stock_status='reserved'） → deals.status='sold'、delivered=0（未交車）
 *   - 售出（stock_status='sold'，備註「售出」）           → deals.status='sold'、delivered=1；從未交車變售出那次，成交日改成那次匯入日
 *   售價＝調作價（實賣價）；沒填就用開價並標 price_source='sheet_list'。成本從車源表來 → 估算毛利。
 *   業務＝括號裡的暱稱：先查暱稱表，查不到就用「名字結尾唯一符合」（安 → 賴安）；還是對不到就留空並回報。
 *   貸款：送貸 → pending、過件 → approved、倒件／沒過 → rejected。
 *   沒有客戶（contact_id 為空）；之後送貨囉貼文對到同一台車，reconcile.applyReport 會換成貼文的成交。
 *   車源表沒有成交日：closed_at 用同步當下，畫面標「匯入日」。
 *   同一台車已經有貼文／對話來的成交 → 車源表不再產生，避免重複計算。
 *   還沒交車就變回在庫 → 那筆刪掉（訂金退了或貸款沒過，車源表沒說原因，不猜）；已交車的不動。
 */
import type { DbLike } from "../adapters/import.ts";
import { staffResolver } from "./reconcile.ts";
import { statusStaff } from "./csv.ts";

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => String(v ?? "");

export interface SheetDealsReport { created: number; updated: number; removed: number; skipped_has_deal: number; unresolved_staff: string[] }

export async function syncSheetDeals(db: DbLike, opts: { now: string }): Promise<SheetDealsReport> {
  const rep: SheetDealsReport = { created: 0, updated: 0, removed: 0, skipped_has_deal: 0, unresolved_staff: [] };
  const res = await staffResolver(db);
  const users = await db.all("SELECT id, name FROM users WHERE role <> 'admin'");
  const resolveStaff = (name: string): number | null => {
    if (!name) return null;
    const direct = res.resolve(name); if (direct) return direct;
    const tail = users.filter((u) => str(u["name"]).endsWith(name));   // 「安」→ 賴安：只有一個人名字結尾是安才算
    return tail.length === 1 ? num(tail[0]!["id"]) : null;
  };
  const vehicles = await db.all(`SELECT * FROM vehicles WHERE source = 'stock'
    AND (stock_status IN ('sold','reserved') OR id IN (SELECT vehicle_id FROM deals WHERE source_system = 'sheet' AND vehicle_id IS NOT NULL))`);
  for (const v of vehicles) {
    const vid = num(v["id"]), st = str(v["stock_status"]);
    const mine: Row | null = await db.first("SELECT * FROM deals WHERE vehicle_id = ? AND source_system = 'sheet' ORDER BY id LIMIT 1", vid);
    if (st !== "sold" && st !== "reserved") {
      if (mine && !num(mine["delivered"])) { await db.run("DELETE FROM deals WHERE id = ?", num(mine["id"])); rep.removed++; }
      continue;
    }
    const other = await db.first("SELECT id FROM deals WHERE vehicle_id = ? AND status = 'sold' AND source_system <> 'sheet' LIMIT 1", vid);
    if (other) { if (mine) { await db.run("DELETE FROM deals WHERE id = ?", num(mine["id"])); rep.removed++; } rep.skipped_has_deal++; continue; }

    const sell = v["sell_price"] == null ? 0 : num(v["sell_price"]);
    const price = sell || num(v["list_price"]);
    const priceSource = sell ? "sheet_sell" : "sheet_list";
    const costKnown = !!num(v["cost_known"]);
    const cost = costKnown ? num(v["cost"]) : 0, gp = costKnown ? price - cost : 0, costSource = costKnown ? "sheet" : "none";
    const statusText = str(v["status_text"]).trim();
    const staffName = statusStaff(statusText);
    const staffId = resolveStaff(staffName);
    if (staffName && !staffId && !rep.unresolved_staff.includes(staffName)) rep.unresolved_staff.push(staffName);
    const loan = /過件/.test(statusText) ? "approved" : /送貸|對保/.test(statusText) ? "pending" : /倒件|沒過|退件/.test(statusText) ? "rejected" : "";
    const delivered = st === "sold" ? 1 : 0;
    const sheetStatus = statusText || (st === "sold" ? "售出（備註）" : "");
    const extKey = `sheet:${str(v["plate_norm"]) || `v${vid}`}`;
    if (!mine) {
      await db.run(
        `INSERT INTO deals (lead_id, contact_id, staff_id, vehicle_id, status, sale_price, cost, gross_profit, lost_reason, closed_at, external_key, source_system,
                            plate, customer_ref, deposit, loan_status, delivery_by, reported_by, source_kind, peer_dealer, cost_source, gp_is_estimate, report_id, price_source, sheet_status, delivered)
         VALUES (NULL, NULL, ?, ?, 'sold', ?, ?, ?, '', ?, ?, 'sheet', ?, '', '', ?, '', '', 'stock', '', ?, ?, NULL, ?, ?, ?)`,
        staffId, vid, price, cost, gp, opts.now, extKey, str(v["plate"]), loan, costSource, costKnown ? 1 : 0, priceSource, sheetStatus, delivered);
      rep.created++;
    } else {
      // 從未交車變成售出那次，成交日改成這次匯入日（CASE 裡的 delivered 是舊值）
      await db.run(
        `UPDATE deals SET status = 'sold', sale_price = ?, cost = ?, gross_profit = ?, cost_source = ?, gp_is_estimate = ?, price_source = ?, staff_id = COALESCE(staff_id, ?),
                          plate = ?, loan_status = ?, sheet_status = ?, closed_at = CASE WHEN delivered = 0 AND ? = 1 THEN ? ELSE closed_at END, delivered = ? WHERE id = ?`,
        price, cost, gp, costSource, costKnown ? 1 : 0, priceSource, staffId, str(v["plate"]), loan, sheetStatus, delivered, opts.now, delivered, num(mine["id"]));
      rep.updated++;
    }
  }
  return rep;
}
