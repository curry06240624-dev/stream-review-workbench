/**
 * 洞察層（決定性）。
 *
 * 洞察從分析數字用門檻規則推出來，不是 AI 想出來的 —— 這樣每一條都可稽核、可重現。
 * AI 只負責在上面寫敘事、提假設、給建議（見 ai.ts）。
 *
 * 每條洞察：
 *   claim      fact（數字本身）／correlation（兩個數字一起動）／hypothesis（AI 才准提）
 *   severity   critical / high / medium / low
 *   confidence 依樣本數：n 小就降級，畫面要顯示 n
 *   evidence   指向期間內的漏斗事件 → 事件的證據訊息。沒證據的候選會被丟掉。
 */
import type { Analytics } from "./analytics.ts";
import type { DbLike } from "../adapters/import.ts";
import type { Claim, Confidence, InsightKind, Severity } from "../model/types.ts";

type Row = Record<string, unknown>;

export interface InsightCandidate {
  kind: InsightKind; title: string; summary: string; claim: Claim; severity: Severity; confidence: Confidence;
  metric: { value?: number; delta?: number; n?: number; baseline?: number; unit?: string };
  /** 證據要跟主張一樣窄：kinds＝只取「需要注意」清單裡那些 lead；below_cost＝只取賠錢的那幾筆 */
  evidence: { event_types: string[]; staff?: string; vehicle?: string; kinds?: string[]; below_cost?: boolean };
  actions: Array<{ text: string; owner_role: "ceo" | "manager" | "staff" }>;
}

const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const wan = (n: number) => `${Math.round(n / 10_000).toLocaleString()} 萬`;
const confByN = (n: number): Confidence => (n >= 20 ? "CONFIRMED" : n >= 8 ? "STRONGLY_SUGGESTED" : n >= 4 ? "POSSIBLE" : "UNCLEAR");

export function deriveInsights(a: Analytics): InsightCandidate[] {
  const out: InsightCandidate[] = [];
  const P = `${a.period.days} 天`;

  /* ── 價格後流失（最重要）── */
  const pd = a.price_dropoff;
  if (pd.base >= 6 && pd.rate != null) {
    const worse = pd.prev_rate != null && pd.prev_base >= 6 && pd.rate - pd.prev_rate >= 0.10;
    const highAbs = pd.rate >= 0.25;
    if (worse || highAbs) {
      const top = pd.by_body_type.filter((b) => b.priced >= 4 && b.rate != null && b.rate >= (pd.rate ?? 0) + 0.15)[0];
      const topStaff = pd.by_staff.filter((s) => s.priced >= 4 && s.rate != null && s.rate >= (pd.rate ?? 0) + 0.2)[0];
      out.push({
        kind: "price_dropoff",
        title: worse ? `價格後流失率上升到 ${pct(pd.rate)}（前期 ${pct(pd.prev_rate)}）` : `價格後流失率 ${pct(pd.rate)}，${pd.count}/${pd.base} 位報價後消失`,
        summary: `最近 ${P} 業務報價 ${pd.base} 次，其中 ${pd.count} 位客戶之後沒有正向回應。` +
          (top ? `${top.body_type.toUpperCase()} 車型特別明顯（${top.dropped}/${top.priced}＝${pct(top.rate)}）。` : "") +
          (topStaff ? `${topStaff.staff} 經手的案子流失率 ${pct(topStaff.rate)}（${topStaff.dropped}/${topStaff.priced}），值得看一下他的報價方式。` : ""),
        claim: top || topStaff ? "correlation" : "fact",
        severity: pd.rate >= 0.35 || (worse && pd.rate >= 0.25) ? "high" : "medium",
        confidence: confByN(pd.base),
        metric: { value: pd.rate, delta: pd.prev_rate == null ? undefined : pd.rate - pd.prev_rate, n: pd.base, baseline: pd.prev_rate ?? undefined, unit: "rate" },
        evidence: { event_types: ["PRICE_DROP_OFF"], ...(topStaff ? { staff: topStaff.staff } : {}) },
        actions: [
          { text: "報價後 24 小時內沒有回應的客戶，由業務主動補一則「有沒有什麼疑慮」的訊息", owner_role: "manager" },
          ...(top ? [{ text: `檢查 ${top.body_type.toUpperCase()} 的定價是否高於市場行情，或報價時是否有先講清楚車況與保固` as string, owner_role: "manager" as const }] : []),
        ],
      });
    }
  }

  /* ── 漏斗瓶頸：最低的那段轉換 ── */
  const pairs: Array<[string, string]> = [["price_to_booking", "報價 → 預約"], ["booking_to_visit", "預約 → 到店"], ["visit_to_sold", "到店 → 成交"]];
  const weakest = pairs.map(([k, label]) => ({ k, label, ...a.conversion[k]! })).filter((x) => x.n >= 8 && x.rate != null).sort((x, y) => (x.rate ?? 1) - (y.rate ?? 1))[0];
  if (weakest && weakest.rate != null && weakest.rate < 0.45) {
    const drop = weakest.prev_rate != null && weakest.prev_n >= 8 && weakest.prev_rate - weakest.rate >= 0.10;
    out.push({
      kind: "funnel_stage", title: `${weakest.label} 是目前最弱的一段：${pct(weakest.rate)}${drop ? `（前期 ${pct(weakest.prev_rate)}）` : ""}`,
      summary: `最近 ${P} 走到「${weakest.label.split(" → ")[0]}」的 ${weakest.n} 位客戶，只有 ${pct(weakest.rate)} 進到下一步。${drop ? "而且比前期明顯下滑。" : ""}`,
      claim: "fact", severity: drop ? "high" : "medium", confidence: confByN(weakest.n),
      metric: { value: weakest.rate, delta: weakest.prev_rate == null ? undefined : weakest.rate - weakest.prev_rate, n: weakest.n, unit: "rate" },
      evidence: { event_types: [weakest.k === "price_to_booking" ? "PRICE_MENTIONED" : weakest.k === "booking_to_visit" ? "APPOINTMENT_BOOKED" : "STORE_VISIT"] },
      actions: [{ text: `把「${weakest.label}」這段的對話抽 10 則出來，找出客戶在這裡停下來的共同原因`, owner_role: "manager" }],
    });
  }

  /* ── 預約 ── */
  const ap = a.appointments;
  if ((ap["booked"] ?? 0) >= 8 && (ap["no_show_rate"] ?? 0) >= 0.2) {
    out.push({
      kind: "appointment", title: `爽約率 ${pct(ap["no_show_rate"])}：${ap["no_show"]} 位預約了沒來`,
      summary: `最近 ${P} 成立 ${ap["booked"]} 個預約，${ap["no_show"]} 個沒有到店。${(ap["prev_no_show_rate"] ?? 0) < (ap["no_show_rate"] ?? 0) - 0.05 ? `前期是 ${pct(ap["prev_no_show_rate"])}，在變差。` : ""}`,
      claim: "fact", severity: (ap["no_show_rate"] ?? 0) >= 0.3 ? "high" : "medium", confidence: confByN(ap["booked"] ?? 0),
      metric: { value: ap["no_show_rate"] ?? undefined, n: ap["booked"] ?? undefined, baseline: ap["prev_no_show_rate"] ?? undefined, unit: "rate" },
      evidence: { event_types: ["NO_SHOW"] },
      actions: [{ text: "預約前一天傍晚固定發一則確認訊息，並問客戶要不要改時間（改期比爽約好）", owner_role: "manager" }],
    });
  }
  if ((ap["proposed"] ?? 0) >= 8 && (ap["booking_rate"] ?? 1) < 0.5) {
    out.push({
      kind: "appointment", title: `業務提議看車 ${ap["proposed"]} 次，只有 ${pct(ap["booking_rate"])} 真的約成`,
      summary: `最近 ${P} 提議看車後客戶答應的比例偏低。可能是提議的時機太早（還沒建立信任）或給的時段不夠彈性。`,
      claim: "fact", severity: "medium", confidence: confByN(ap["proposed"] ?? 0),
      metric: { value: ap["booking_rate"] ?? undefined, n: ap["proposed"] ?? undefined, unit: "rate" },
      evidence: { event_types: ["APPOINTMENT_PROPOSED"] },
      actions: [{ text: "提議看車時直接給兩個具體時段讓客戶選，而不是問「什麼時候有空」", owner_role: "staff" }],
    });
  }

  /* ── 跟進缺口（最直接可行動）── */
  const hiNo = a.attention.filter((x) => x.kind === "high_intent_no_followup");
  if (hiNo.length >= 2) {
    out.push({
      kind: "followup", title: `${hiNo.length} 位最近兩週說急的客戶，沉默後沒有再跟進`,
      summary: `這些客戶早期就說「急」「有現車就可以」「這週要決定」，客戶沉默超過 24 小時後業務沒有再主動聯絡：${hiNo.slice(0, 3).map((x) => `${x.contact}（${x.staff}）`).join("、")}${hiNo.length > 3 ? " 等" : ""}。這是最容易撿回來的單。`,
      claim: "fact", severity: hiNo.length >= 5 ? "critical" : "high", confidence: "CONFIRMED",
      metric: { value: hiNo.length, n: hiNo.length, unit: "leads" },
      evidence: { event_types: ["HIGH_INTENT"], kinds: ["high_intent_no_followup"] },
      actions: [{ text: "今天就把這幾位分回給原業務，24 小時內要有一則主動訊息", owner_role: "manager" }],
    });
  }
  const pdNo = a.attention.filter((x) => x.kind === "price_dropoff_no_followup");
  if (pdNo.length >= 3) {
    out.push({
      kind: "followup", title: `${pdNo.length} 位報價後消失的客戶，兩週內沒有任何跟進`,
      summary: `報價後沉默不代表不買，但沒有人再問一句就真的不會回來了。`, claim: "fact", severity: "medium", confidence: "CONFIRMED",
      metric: { value: pdNo.length, n: pdNo.length, unit: "leads" }, evidence: { event_types: ["PRICE_DROP_OFF"], kinds: ["price_dropoff_no_followup"] },
      actions: [{ text: "報價後第 3 天沒回應的客戶，統一發一則「這台還在，有其他預算內的選擇也可以幫您找」", owner_role: "staff" }],
    });
  }

  /* ── 貸款 ── */
  const finNo = a.attention.filter((x) => x.kind === "financing_unresolved");
  if (finNo.length >= 3) {
    out.push({
      kind: "financing", title: `${finNo.length} 位客戶問了貸款，24 小時內沒有人回`,
      summary: `問貸款的客戶通常是想買、只是在算負不負擔得起；一天沒人回就去別家問了。`, claim: "fact", severity: "medium", confidence: "CONFIRMED",
      metric: { value: finNo.length, n: finNo.length, unit: "leads" }, evidence: { event_types: ["FINANCING_QUESTION"], kinds: ["financing_unresolved"] },
      actions: [{ text: "準備一張「頭期／月付速算表」讓業務當場回答，或在 24 小時內轉貸款專員", owner_role: "manager" }],
    });
  }

  /* ── 車款 ── */
  const hot = a.vehicles.filter((v) => v.inquiries >= 8 && v.inquiry_to_sold != null && v.inquiry_to_sold <= 0.15).sort((x, y) => y.inquiries - x.inquiries)[0];
  if (hot) out.push({
    kind: "vehicle", title: `${hot.name} 詢問最多（${hot.inquiries} 位）但只成交 ${hot.sold} 台`,
    summary: `這台車吸引流量，卻留不住人：${hot.dropped} 位在報價後消失。要嘛定價偏離行情，要嘛來問的人本來就在比價。`,
    claim: "correlation", severity: "medium", confidence: confByN(hot.inquiries),
    metric: { value: hot.inquiry_to_sold ?? undefined, n: hot.inquiries, unit: "rate" }, evidence: { event_types: ["PRICE_DROP_OFF", "PRICE_MENTIONED"], vehicle: hot.name },
    actions: [{ text: `查 ${hot.name} 同年式的市場成交價，決定要調價還是改成用它引流、再導到毛利較好的車`, owner_role: "ceo" }],
  });
  const quiet = a.vehicles.filter((v) => v.inquiries >= 4 && v.inquiry_to_sold != null && v.inquiry_to_sold >= 0.6).sort((x, y) => y.gross_profit - x.gross_profit)[0];
  if (quiet) out.push({
    kind: "opportunity", title: `${quiet.name} 問的人不多，但問了就買（${pct(quiet.inquiry_to_sold)}）`,
    summary: `${quiet.inquiries} 位詢問成交 ${quiet.sold} 台、毛利 ${wan(quiet.gross_profit)}。這種車值得多進、多曝光。`,
    claim: "correlation", severity: "low", confidence: confByN(quiet.inquiries),
    metric: { value: quiet.inquiry_to_sold ?? undefined, n: quiet.inquiries, unit: "rate" }, evidence: { event_types: ["SOLD"], vehicle: quiet.name },
    actions: [{ text: `盤點 ${quiet.name} 同級車的庫存，考慮在 Meta 廣告多推這一類`, owner_role: "ceo" }],
  });

  /* ── 業務 ── */
  const slow = a.staff.filter((s) => s.leads >= 8 && s.median_first_response_min != null && s.median_first_response_min >= 120).sort((x, y) => (y.median_first_response_min ?? 0) - (x.median_first_response_min ?? 0))[0];
  if (slow) out.push({
    kind: "staff", title: `${slow.name} 首次回覆中位數 ${Math.round((slow.median_first_response_min ?? 0) / 60)} 小時`,
    summary: `${slow.name} 手上 ${slow.leads} 個 lead，客戶第一則訊息平均要等 ${slow.median_first_response_min} 分鐘才有人回；同組最快的是 ${Math.min(...a.staff.filter((s) => s.median_first_response_min != null).map((s) => s.median_first_response_min!))} 分鐘。晚上 8–10 點是進線尖峰，這段時間誰在線很關鍵。`,
    claim: "correlation", severity: "medium", confidence: confByN(slow.leads),
    metric: { value: slow.median_first_response_min ?? undefined, n: slow.leads, unit: "min" }, evidence: { event_types: ["NEW_LEAD"], staff: slow.name },
    actions: [{ text: `跟 ${slow.name} 確認排班與手機通知設定；尖峰時段考慮由值班的人先回第一句`, owner_role: "manager" }],
  });

  /* ── 毛利 ── */
  const d = a.deals;
  if (d.below_cost >= 1) out.push({
    kind: "anomaly", title: `${d.below_cost} 筆成交低於成本`,
    summary: `最近 ${P} 有 ${d.below_cost} 台賣價低於進車成本。可能是議價讓太多，或成本登記錯誤，兩種都要查。`,
    claim: "fact", severity: "high", confidence: "CONFIRMED", metric: { value: d.below_cost, n: d.sold, unit: "deals" }, evidence: { event_types: ["SOLD"], below_cost: true },
    actions: [{ text: "把低於成本的那幾筆調出來，逐筆確認是誰核准的折扣", owner_role: "ceo" }],
  });
  if (d.sold >= 5 && d.gp_margin != null && d.gp_margin < 0.06) out.push({
    kind: "anomaly", title: `毛利率只有 ${pct(d.gp_margin)}（${d.sold} 台、毛利 ${wan(d.gross_profit)}）`,
    summary: `營收 ${wan(d.revenue)} 但毛利 ${wan(d.gross_profit)}。成交量不是問題，每台留下的錢才是。`, claim: "fact",
    severity: "medium", confidence: confByN(d.sold), metric: { value: d.gp_margin, n: d.sold, unit: "rate" }, evidence: { event_types: ["NEGOTIATION", "SOLD"] },
    actions: [{ text: "設定每台車的議價底線並寫進系統，超過底線要主管核准", owner_role: "ceo" }],
  });
  if (d.prev_sold >= 3 && d.sold >= d.prev_sold * 1.5) out.push({
    kind: "opportunity", title: `成交 ${d.sold} 台，是前期（${d.prev_sold}）的 ${(d.sold / d.prev_sold).toFixed(1)} 倍`,
    summary: `最近 ${P} 成交明顯增加，毛利 ${wan(d.gross_profit)}。值得看是哪幾位業務、哪幾款車撐起來的，把做法複製出去。`,
    claim: "fact", severity: "low", confidence: confByN(d.sold), metric: { value: d.sold, baseline: d.prev_sold, n: d.sold, unit: "deals" }, evidence: { event_types: ["SOLD"] },
    actions: [{ text: "在週會請本期成交最多的業務分享一個實際案例", owner_role: "manager" }],
  });

  /* ── 進線量異常 ── */
  const f = a.funnel;
  if (f.prev_leads >= 10 && Math.abs(f.leads - f.prev_leads) / f.prev_leads >= 0.4) {
    const up = f.leads > f.prev_leads;
    out.push({
      kind: "anomaly", title: `新進線 ${f.leads} 位，比前期${up ? "多" : "少"} ${Math.round(Math.abs(f.leads - f.prev_leads) / f.prev_leads * 100)}%`,
      summary: up ? "進線變多，先確認業務回覆速度有沒有跟上（見首次回覆時間）。" : "進線變少，先看廣告投放有沒有中斷。", claim: "fact",
      severity: up ? "low" : "medium", confidence: "CONFIRMED", metric: { value: f.leads, baseline: f.prev_leads, n: f.leads, unit: "leads" }, evidence: { event_types: ["NEW_LEAD"] },
      actions: [{ text: up ? "確認尖峰時段的值班人力" : "跟投放的人確認這週的廣告狀態", owner_role: "manager" }],
    });
  }

  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((x, y) => order[x.severity] - order[y.severity]);
}

/** 落庫：同期間重算會先清掉未被駁回的舊洞察；被駁回的（dismissed）保留且不重建同名的。 */
export async function persistInsights(db: DbLike, cands: InsightCandidate[], a: Analytics, now: string): Promise<{ ids: number[] }> {
  const { from, to } = a.period;
  const dismissed = new Set((await db.all("SELECT title FROM insights WHERE period_from = ? AND period_to = ? AND dismissed = 1", from, to)).map((r) => String(r["title"])));
  const old = await db.all("SELECT id FROM insights WHERE period_from = ? AND period_to = ? AND dismissed = 0", from, to);
  for (const r of old) {
    await db.run("DELETE FROM evidence WHERE insight_id = ?", r["id"]);
    await db.run("DELETE FROM actions WHERE insight_id = ? AND status = 'proposed'", r["id"]);
    await db.run("DELETE FROM insights WHERE id = ?", r["id"]);
  }
  const ids: number[] = [];
  for (const c of cands) {
    if (dismissed.has(c.title)) continue;
    // 證據要跟主張一樣窄。「需要注意」型：只取清單裡那些 lead；其他：期間內符合條件的事件（最多 30 則）
    let evRows: Row[] = [];
    if (c.evidence.kinds) {
      const leadIds = a.attention.filter((x) => c.evidence.kinds!.includes(x.kind)).map((x) => x.lead_id);
      if (leadIds.length) evRows = await db.all(
        `SELECT x.message_id, x.note, e.lead_id FROM funnel_events e JOIN evidence x ON x.event_id = e.id
          WHERE e.lead_id IN (${leadIds.map(() => "?").join(",")}) AND e.type IN (${c.evidence.event_types.map(() => "?").join(",")}) AND x.message_id IS NOT NULL LIMIT 30`,
        ...leadIds, ...c.evidence.event_types);
    } else {
      const where: string[] = [`e.type IN (${c.evidence.event_types.map(() => "?").join(",")})`, "e.at >= ?", "e.at < ?", "e.confidence <> 'UNCLEAR'"];
      const args: unknown[] = [...c.evidence.event_types, from, to];
      if (c.evidence.staff) { where.push("u.name = ?"); args.push(c.evidence.staff); }
      if (c.evidence.vehicle) { where.push("(v.brand || ' ' || v.model) = ?"); args.push(c.evidence.vehicle); }
      if (c.evidence.below_cost) where.push("EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = e.lead_id AND d.status = 'sold' AND d.gross_profit < 0)");
      evRows = await db.all(
        `SELECT x.message_id, x.note, e.lead_id FROM funnel_events e JOIN evidence x ON x.event_id = e.id
           LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN users u ON u.id = l.staff_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
          WHERE ${where.join(" AND ")} AND x.message_id IS NOT NULL ORDER BY e.at DESC LIMIT 30`, ...args);
    }
    if (!evRows.length) continue;                                   // 沒證據就不上畫面
    const r = await db.run(
      `INSERT INTO insights (kind, title, summary, claim, severity, confidence, metric, period_from, period_to, created_at, dismissed) VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
      c.kind, c.title, c.summary, c.claim, c.severity, c.confidence, JSON.stringify(c.metric), from, to, now);
    const id = r.lastRowId; ids.push(id);
    for (const e of evRows) await db.run("INSERT INTO evidence (insight_id, message_id, lead_id, note) VALUES (?,?,?,?)", id, e["message_id"], e["lead_id"], e["note"]);
    for (const act of c.actions) await db.run("INSERT INTO actions (insight_id, text, owner_role, status, created_at) VALUES (?,?,?,'proposed',?)", id, act.text, act.owner_role, now);
  }
  return { ids };
}
