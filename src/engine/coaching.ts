/**
 * 教練層 —— 個人教練計畫（規則版；AI 只潤稿）、訊息改寫建議（只建議、永遠不代發）、CEO 決策卡、管理行動的前後對照。
 *
 * 每一條建議都要講：改什麼、為什麼、證據是什麼、像哪個成功模式、多有把握。
 * 「為什麼」只准引用：本人數字、表現最佳組數字、團隊數字、行為 × 結果的關聯（標關聯）。
 */
import type { DbLike } from "../adapters/import.ts";
import { computeStaffReport, MIN_N, pct, wan, type StaffReport, type StaffMetrics, type Metric, type NumMetric, type Issue } from "./staff.ts";
import { FEATURE_LABEL } from "./behavior.ts";
import { LOSS_LABEL } from "./loss.ts";

type Row = Record<string, unknown>;
const D = 86_400_000;
const num = (v: unknown) => Number(v ?? 0) || 0;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const confOf = (n: number) => (n >= 10 ? "STRONGLY_SUGGESTED" : n >= 5 ? "POSSIBLE" : "UNCLEAR");
const isRate = (m: Metric | NumMetric | undefined): m is Metric => !!m && "rate" in m;
const valOf = (m: Metric | NumMetric | undefined) => (m == null ? null : isRate(m) ? m.rate : m.value);
const fmtF = (key: string, v: number | null) => { const u = FEATURE_LABEL[key]?.unit ?? "rate"; return v == null ? "—" : u === "rate" || u === "pct" ? pct(v) : u === "min" ? `${Math.round(v)} 分鐘` : u === "hour" ? `${Math.round(v)} 小時` : String(v); };

/* ── 建議語料：改什麼、像哪個成功模式 ── */
const ADVICE: Record<string, { text: string; pattern: string }> = {
  asked_after_price: { text: "報價後不要停在數字：接一個診斷式問題（預算範圍、月付或總價、有沒有舊車要換購），讓客戶有話可回。", pattern: "報價後接一個問題" },
  objection_clarified: { text: "客戶說太貴時，先問他心中的數字或在意的是總價還是月付，再談方案；不要直接回「已經是底價」。", pattern: "價格異議後先釐清" },
  proposed_after_intent: { text: "客戶表達急迫（這週要決定、要交車）時，當下給兩個看車時段讓他選，不要只報價。", pattern: "高意圖立刻約看車" },
  fin_answered: { text: "貸款問題當下就給數字（頭期、月付、利率區間）或直接轉貸款專員，不要說「我再問」。", pattern: "貸款講得具體" },
  postvisit_24h: { text: "到店沒當場成交的客戶，24 小時內發一則整理訊息（今天看的車、價格、下一步），再約下一次。", pattern: "到店後 24 小時內跟進" },
  followup_24h_rate: { text: "客戶沉默 24 小時就跟進一次、72 小時再一次；用看車時段或新資訊去敲，不要問「考慮得怎樣」。", pattern: "沉默後跟進" },
  first_response_min: { text: "新進線 15 分鐘內先回一句（在的、車還在、方便問預算嗎），細節之後補；回慢的客戶多數不會再回。", pattern: "快速首次回覆" },
  budget_clarified: { text: "開場就問預算範圍，之後報價才不會超出客戶預期，也比較容易推薦替代車款。", pattern: "開場問預算" },
  reactivated_by_staff: { text: "沉默一週以上的客戶，用新進車或談到的價格去敲；回來的客戶立刻約看車。", pattern: "把沉默客戶叫回來" },
  escalated: { text: "遇到專業問題或價格僵局，早一點拉主管或懂車的同事進來，不要自己卡住。", pattern: "找主管或同事協助" },
};
const COACH_FEATURES = ["first_response_min", "followup_24h_rate", "asked_after_price", "objection_clarified", "proposed_after_intent", "fin_answered", "postvisit_24h", "budget_clarified", "reactivated_by_staff", "escalated"];

export interface CoachingPlan {
  staff_id: number; name: string; period: StaffReport["period"];
  main_issue: Issue | null;
  compared: Array<{ feature: string; label: string; mine: number | null; peers: number | null; team: number | null; n: number; peers_n: number; unit: string; gap: number | null; worse: boolean }>;
  evidence: { affected_leads: number; conversations: Array<{ lead_id: number; contact: string; reason: string; driver: string; stage: string }>; benchmark: string };
  changes: Array<{ key: string; text: string; why: string; evidence: string; pattern: string; confidence: string }>;
  message_examples: Array<{ kind: string; lead_id: number; message_id: number; contact: string; current: string; issue: string; stronger: string; suggested: string; note: string }>;
  strengths: string[]; insufficient: string[];
  peers_label: string; generated_at: string; model: string;
}

/** 池化一群人的同一個指標（比例用 k/n，數值取中位數） */
function poolPeers(ms: Array<Metric | NumMetric | undefined>): { value: number | null; n: number } {
  const xs = ms.filter((m): m is Metric | NumMetric => !!m);
  if (!xs.length) return { value: null, n: 0 };
  if (isRate(xs[0])) { const k = xs.reduce((a, m) => a + (isRate(m) ? m.k : 0), 0), n = xs.reduce((a, m) => a + m.n, 0); return { value: n ? r3(k / n) : null, n }; }
  const vals = xs.map((m) => (isRate(m) ? null : m.value)).filter((v): v is number => v != null).sort((a, b) => a - b);
  const n = xs.reduce((a, m) => a + m.n, 0); const mid = Math.floor(vals.length / 2);
  return { value: vals.length ? (vals.length % 2 ? vals[mid]! : r3((vals[mid - 1]! + vals[mid]!) / 2)) : null, n };
}

export async function buildCoachingPlan(db: DbLike, report: StaffReport, staffId: number, now: string): Promise<CoachingPlan | null> {
  const s = report.staff.find((x) => x.id === staffId); if (!s) return null;
  const isTop = report.compare.top_ids.includes(staffId);
  const peerIds = isTop ? report.staff.filter((x) => x.id !== staffId).map((x) => x.id) : report.compare.top_ids;
  const peers = report.staff.filter((x) => peerIds.includes(x.id));
  const peersLabel = isTop ? "其他同事" : "表現最佳組";
  const issues = report.issues[staffId] ?? [];

  /* 行為對照 */
  const compared: CoachingPlan["compared"] = [];
  for (const key of COACH_FEATURES) {
    const mine = s.behaviors[key]; const p = poolPeers(peers.map((x) => x.behaviors[key])); const t = valOf(report.team.behaviors[key]);
    const mv = valOf(mine); if (!mine) continue;
    const meta = FEATURE_LABEL[key]; const good = meta?.goodIsUp ?? true;
    const gap = mv != null && p.value != null ? r3(mv - p.value) : null;
    const worse = gap != null && (meta?.unit === "min" ? mv! >= Math.max(30, p.value! * 2) : (good ? gap <= -0.15 : gap >= 0.15));
    compared.push({ feature: key, label: meta?.label ?? key, mine: mv, peers: p.value, team: t, n: mine.n, peers_n: p.n, unit: meta?.unit ?? "rate", gap, worse: worse && mine.ok });
  }

  /* 建議：漏斗問題 + 行為落差，各附證據與模式 */
  const changes: CoachingPlan["changes"] = [];
  for (const is of issues.slice(0, 2)) changes.push({ key: is.key, text: is.coaching, why: is.text, evidence: `影響 ${is.affected} 位客戶（本期）`, pattern: is.pattern, confidence: confOf(is.n) });
  for (const c of compared.filter((x) => x.worse).sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0))) {
    if (changes.length >= 5) break;
    const adv = ADVICE[c.feature]; if (!adv || changes.some((x) => x.key === c.feature)) continue;
    const SAME: Record<string, string> = { first_response_min: "response", followup_24h_rate: "followup" };   // 同一件事不講兩次
    if (SAME[c.feature] && changes.some((x) => x.key === SAME[c.feature])) continue;
    const assoc = report.associations.find((a) => a.feature === c.feature);
    const assocTxt = assoc && assoc.with.ok && assoc.without.ok ? `全團隊有做到的客戶成交率 ${pct(assoc.with.rate)}（n=${assoc.with.n}），沒做到 ${pct(assoc.without.rate)}（n=${assoc.without.n}）—— 這是關聯，不是因果` : "樣本還不足以看出與成交的關聯";
    changes.push({ key: c.feature, text: adv.text, why: `你 ${fmtF(c.feature, c.mine)}（n=${c.n}），${peersLabel} ${fmtF(c.feature, c.peers)}（n=${c.peers_n}），團隊 ${fmtF(c.feature, c.team)}`, evidence: assocTxt, pattern: adv.pattern, confidence: confOf(c.n) });
  }

  /* 證據：本期流失客戶（流程面優先） */
  const lostRows = await db.all(
    `SELECT la.lead_id, la.primary_reason, la.driver, la.stage, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact
       FROM loss_analyses la JOIN leads l ON l.id = la.lead_id JOIN contacts c ON c.id = l.contact_id
      WHERE l.staff_id = ? AND l.opened_at >= ? AND l.opened_at < ? AND la.status = 'lost'
      ORDER BY CASE la.driver WHEN 'process' THEN 0 ELSE 1 END, la.closed_at DESC LIMIT 8`, staffId, report.period.from, report.period.to);
  const evidence: CoachingPlan["evidence"] = {
    affected_leads: issues[0]?.affected ?? 0,
    conversations: lostRows.map((r) => ({ lead_id: num(r["lead_id"]), contact: String(r["contact"]), reason: (LOSS_LABEL as Record<string, string>)[String(r["primary_reason"])] ?? String(r["primary_reason"]), driver: String(r["driver"]), stage: String(r["stage"]) })),
    benchmark: `團隊成交率 ${pct(report.team.funnel.close.rate)}（${report.team.funnel.close.k}/${report.team.funnel.close.n}）、報價後續走 ${pct(report.team.funnel.price_continue.rate)}、沉默後跟進 ${pct(report.team.activity.followup_24h.rate)}`,
  };

  /* 訊息改寫建議：從本人真實訊息挑弱的那幾則 */
  const message_examples = await messageExamples(db, s, report, staffId);

  const strengths: string[] = [];
  for (const r of report.rankings) { const row = r.rows.find((x) => x.staff_id === staffId); if (row?.rank && row.rank <= 2) strengths.push(`${r.label}第 ${row.rank} 名（${row.display}）`); }
  for (const c of compared) { const good = FEATURE_LABEL[c.feature]?.goodIsUp ?? true; if (c.mine != null && c.team != null && c.n >= MIN_N.behavior && (good ? c.mine - c.team >= 0.15 : c.mine <= c.team * 0.5) && c.unit !== "min") strengths.push(`${c.label} ${fmtF(c.feature, c.mine)}（團隊 ${fmtF(c.feature, c.team)}）`); }
  const insufficient: string[] = [];
  const need = [["到店→成交", s.funnel.visit_sale, MIN_N.visit_sale], ["預約→到店", s.funnel.appt_visit, MIN_N.appt_visit], ["報價後續走", s.funnel.price_continue, MIN_N.price_continue], ["成交率", s.funnel.close, MIN_N.close]] as const;
  for (const [label, m, min] of need) if (!m.ok) insufficient.push(`${label}（樣本 ${m.n}，需要 ${min}）`);
  for (const c of compared) if (c.n < MIN_N.behavior) insufficient.push(`${c.label}（情境只出現 ${c.n} 次）`);

  const plan: CoachingPlan = { staff_id: staffId, name: s.name, period: report.period, main_issue: issues[0] ?? null, compared, evidence, changes, message_examples, strengths: strengths.slice(0, 5), insufficient, peers_label: peersLabel, generated_at: now, model: "template" };
  await db.run("INSERT INTO coaching_plans (staff_id, period_from, period_to, content, model, created_at) VALUES (?,?,?,?,?,?)", staffId, report.period.from, report.period.to, JSON.stringify(plan), "template", now);
  return plan;
}

/** 從本人的真實訊息挑出可以改寫的例子（每種最多一則、共三則），改寫版是模板；AI 潤稿在 Worker 端 */
async function messageExamples(db: DbLike, s: StaffMetrics, report: StaffReport, staffId: number): Promise<CoachingPlan["message_examples"]> {
  const rows = await db.all(
    `SELECT b.lead_id, b.features, COALESCE(NULLIF(c.pseudonym,''), c.display_name) AS contact, v.list_price, COALESCE(v.brand||' '||v.model,'') AS vehicle
       FROM behaviors b JOIN leads l ON l.id = b.lead_id JOIN contacts c ON c.id = l.contact_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
      WHERE l.staff_id = ? AND l.opened_at >= ? AND l.opened_at < ? ORDER BY l.opened_at DESC`, staffId, report.period.from, report.period.to);
  const out: CoachingPlan["message_examples"] = [];
  const teamB = (k: string) => pct(valOf(report.team.behaviors[k]));
  const topB = (k: string) => { const p = poolPeers(report.staff.filter((x) => report.compare.top_ids.includes(x.id)).map((x) => x.behaviors[k])); return pct(p.value); };
  const text = async (id: number | null | undefined) => (id ? String((await db.first("SELECT text FROM messages WHERE id = ?", id))?.["text"] ?? "") : "");
  const priceOf = (t: string, list: number) => { const m = t.match(/(\d{2,3})\s*萬/); return m ? Number(m[1]) : Math.round(list / 10_000); };
  const kinds = new Set<string>();
  for (const r of rows) {
    if (out.length >= 3) break;
    let f: Record<string, { v: number | null; msg?: number | null }> = {}; try { f = JSON.parse(String(r["features"] || "{}")); } catch { continue; }
    const lead_id = num(r["lead_id"]), contact = String(r["contact"]), list = num(r["list_price"]), car = String(r["vehicle"]);
    const note = "教練建議，不會自動發送；語氣請照公司習慣調整。";
    if (!kinds.has("price") && f["asked_after_price"]?.v === 0 && f["asked_after_price"]?.msg) {
      const cur = await text(f["asked_after_price"].msg); if (cur) { const p = priceOf(cur, list); kinds.add("price");
        out.push({ kind: "price", lead_id, message_id: f["asked_after_price"].msg!, contact, current: cur, issue: "只給了價格，沒有脈絡也沒有下一步；客戶只能回「好」或消失。",
          stronger: `表現最佳組報價後接問題的比例 ${topB("asked_after_price")}（團隊 ${teamB("asked_after_price")}）：報完價接著問預算、月付或總價、舊車換購。`,
          suggested: `目前這台 ${car} 開價 ${p} 萬、含過戶。想先了解一下您的預算範圍，或是您會考慮貸款／舊車換購嗎？我可以幫您一起算比較適合的方案。`, note }); continue; }
    }
    if (!kinds.has("financing") && f["fin_answered"]?.v === 0 && f["fin_answered"]?.msg) {
      const cur = await text(f["fin_answered"].msg); if (cur) { kinds.add("financing"); const p = Math.round(list / 10_000), d = Math.round(p * 0.2), m = Math.round(((p - d) * 10_000 * 1.07) / 60);
        out.push({ kind: "financing", lead_id, message_id: f["fin_answered"].msg!, contact, current: cur, issue: "貸款問題沒有給答案，客戶要的是一個數字，等待中最容易流失。",
          stronger: `表現最佳組貸款回答具體的比例 ${topB("fin_answered")}（團隊 ${teamB("fin_answered")}）：給頭期、月付、利率區間，或直接轉專員。`,
          suggested: `可以辦喔。以這台 ${p} 萬來說，頭期大約 ${d} 萬、月付約 ${m.toLocaleString("zh-TW")} 元起（實際依銀行核貸），我先幫您試算；方便說一下自備款大概多少嗎？`, note }); continue; }
    }
    if (!kinds.has("objection") && f["objection_clarified"]?.v === 0 && f["objection_clarified"]?.msg) {
      const cur = await text(f["objection_clarified"].msg); if (cur) { kinds.add("objection");
        out.push({ kind: "objection", lead_id, message_id: f["objection_clarified"].msg!, contact, current: cur, issue: "客戶說太貴之後直接收尾，沒有問清楚差多少、在意什麼。",
          stronger: `表現最佳組異議後先釐清的比例 ${topB("objection_clarified")}（團隊 ${teamB("objection_clarified")}）：先問心中數字或總價／月付考量，再談方案。`,
          suggested: `了解～您心中的數字大概是多少？或是您比較在意總價還是月付？我看看有沒有更適合的方案，價格也幫您跟主管爭取看看。`, note }); continue; }
    }
    if (!kinds.has("postvisit") && f["postvisit_24h"]?.v === 0 && f["postvisit_followup_h"]?.msg) {
      const cur = await text(f["postvisit_followup_h"].msg); if (cur) { kinds.add("postvisit");
        out.push({ kind: "postvisit", lead_id, message_id: f["postvisit_followup_h"].msg!, contact, current: cur, issue: `到店後隔了 ${Math.round(f["postvisit_followup_h"]?.v ?? 0)} 小時才跟進，客戶的熱度已經降了。`,
          stronger: `表現最佳組到店後 24 小時內跟進的比例 ${topB("postvisit_24h")}（團隊 ${teamB("postvisit_24h")}）：當天就整理今天看的車、價格、下一步。`,
          suggested: `今天謝謝您來看車！剛剛看的 ${car}，價格我已經幫您跟主管申請，明天前回覆您；另外想確認您比較在意的是總價還是月付，我先把兩種方案算好。`, note }); continue; }
    }
  }
  return out;
}

/* ── 決策卡（CEO）── */
export interface DecisionCard { key: string; priority: "high" | "medium" | "low"; kind: string; title: string; why: string; observed: string; action: string; measure: string; metric_key: string; staff_ids: number[]; links: Array<{ label: string; href: string }>; claim: "fact" | "correlation" }

export async function computeDecisions(db: DbLike, report: StaffReport, now: string): Promise<DecisionCard[]> {
  const cards: DecisionCard[] = [];
  const t = report.team;
  const obs = (feature: string) => report.compare.observations.find((o) => o.feature === feature);
  const obsText = (feature: string, fallback: string) => { const o = obs(feature); return o ? o.text : fallback; };

  // 1. 報價後流失高於團隊的人
  const pc = report.staff.filter((s) => s.funnel.price_continue.ok && t.funnel.price_continue.rate != null && s.funnel.price_continue.rate != null && s.funnel.price_continue.rate <= t.funnel.price_continue.rate - 0.1);
  if (pc.length >= 1) {
    const affected = pc.reduce((a, s) => a + (s.funnel.price_continue.n - s.funnel.price_continue.k), 0);
    cards.push({ key: "price_stage", priority: pc.length >= 2 ? "high" : "medium", kind: "coach", title: `${pc.length} 位業務報價後續走率低於團隊基準`, why: `本期估計 ${affected} 位客戶在報價後停住（${pc.map((s) => `${s.name} ${pct(s.funnel.price_continue.rate)}`).join("、")}；團隊 ${pct(t.funnel.price_continue.rate)}）`,
      observed: obsText("asked_after_price", "表現最佳組報價後比較常接一個問題"), action: `針對這 ${pc.length} 位做價格異議處理與 24 小時跟進的教練`, measure: "接下來 30 天的報價後續走率", metric_key: "price_continue", staff_ids: pc.map((s) => s.id),
      links: [{ label: "查看員工", href: "/staff" }, { label: "查看證據", href: "/loss?by=staff" }], claim: "correlation" });
  }
  // 2. 團隊沉默後跟進偏低
  if (t.activity.followup_24h.ok && t.activity.followup_24h.rate != null && t.activity.followup_24h.rate < 0.6) {
    cards.push({ key: "followup", priority: "medium", kind: "workflow", title: `團隊沉默後 24 小時內跟進只有 ${pct(t.activity.followup_24h.rate)}`, why: `${t.activity.followup_24h.n} 次客戶沉默中只有 ${t.activity.followup_24h.k} 次在 24 小時內被跟進`, observed: obsText("followup_24h_rate", "表現最佳組沉默後跟進比例明顯較高"), action: "把「客戶沉默 24 小時」做成每日清單，主管早會點名", measure: "接下來 30 天的沉默後跟進率", metric_key: "followup_24h", staff_ids: [], links: [{ label: "需要注意", href: "/attention" }], claim: "fact" });
  }
  // 3. 流失原因上升
  const prevLoss = await db.all(`SELECT la.primary_reason, COUNT(*) AS n FROM loss_analyses la JOIN leads l ON l.id = la.lead_id WHERE la.status = 'lost' AND l.opened_at >= ? AND l.opened_at < ? GROUP BY la.primary_reason`, report.prev.from, report.prev.to);
  const prevMap = new Map(prevLoss.map((r) => [String(r["primary_reason"]), num(r["n"])]));
  for (const r of t.loss.reasons) {
    const p = prevMap.get(r.key) ?? 0;
    if (r.k >= 3 && r.k >= p * 1.5 && r.k - p >= 2) {
      const kind = r.key === "financing" ? "review_financing" : r.key === "price_resistance" || r.key === "negotiation_failed" ? "review_pricing" : r.key === "slow_response" || r.key === "weak_followup" ? "workflow" : "review_process";
      cards.push({ key: `loss_${r.key}`, priority: r.k >= 6 ? "high" : "medium", kind, title: `「${r.label}」造成的流失在增加：${r.k} 位（前期 ${p}）`, why: `本期流失 ${t.loss.n} 位中 ${r.k} 位主因是${r.label}`, observed: "見流失原因分析的支持對話", action: kind === "review_financing" ? "檢視貸款回覆流程：誰負責、多久內給數字" : kind === "review_pricing" ? "檢視報價與議價流程：底價授權、替代車款" : "檢視這類流失的對話，找共同點", measure: "下一期同原因的流失數", metric_key: `loss:${r.key}`, staff_ids: [], links: [{ label: "查看流失分析", href: `/loss?reason=${r.key}` }], claim: "fact" });
    }
  }
  // 4. 高量低毛利
  if (t.commercial.avg_gp.value != null) {
    const low = report.staff.filter((s) => s.commercial.sold >= 5 && s.commercial.avg_gp.ok && s.commercial.avg_gp.value != null && s.commercial.avg_gp.value <= t.commercial.avg_gp.value! * 0.6);
    if (low.length) cards.push({ key: "profit_quality", priority: "medium", kind: "review_pricing", title: `${low.length} 位業務成交量高但每台毛利偏低`, why: low.map((s) => `${s.name} ${s.commercial.sold} 台、每台毛利 ${wan(s.commercial.avg_gp.value!)}（團隊 ${wan(t.commercial.avg_gp.value!)}）`).join("；"), observed: "折讓幅度與議價次數見員工檔案", action: "檢視這幾位的折讓授權與議價話術；高量不等於高毛利", measure: "接下來 30 天的每台毛利", metric_key: "avg_gp", staff_ids: low.map((s) => s.id), links: [{ label: "成交與毛利", href: "/deals" }], claim: "fact" });
  }
  // 4b. 沒有成本的成交（同行車、車號空白）：毛利算不出來，是資料流的問題不是業務的問題
  const noCost = await db.first("SELECT COUNT(*) AS n, COALESCE(SUM(sale_price),0) AS amount FROM deals WHERE status = 'sold' AND cost_source = 'none' AND closed_at >= ? AND closed_at < ?", report.period.from, report.period.to);
  if (num(noCost?.["n"]) >= 3) cards.push({ key: "gp_unknown", priority: "medium", kind: "review_process", title: `${num(noCost?.["n"])} 筆成交沒有成本，毛利算不出來`, why: `售價合計 ${wan(num(noCost?.["amount"]))}；同行的車不在車源表、或送貨囉貼文車號空白，對不到成本。正式毛利只有會計有。`, observed: "毛利頁與員工毛利都只算成本知道的成交，這幾筆不在裡面", action: "請會計每月給一份成交成本表；送貨囉貼文一律填車號，同行車加一欄成本", measure: "下月沒有成本的成交筆數", metric_key: "", staff_ids: [], links: [{ label: "待確認配對", href: "/reconcile" }, { label: "成交與毛利", href: "/deals" }], claim: "fact" });
  // 4c. 送貨囉貼文還沒對到客戶或車：沒對上的成交不會算進成交率與毛利
  const pend = await db.first("SELECT SUM(CASE WHEN match_status = 'suggested' THEN 1 ELSE 0 END) AS s, SUM(CASE WHEN match_status = 'unmatched' THEN 1 ELSE 0 END) AS u FROM deal_reports");
  const pendN = num(pend?.["s"]) + num(pend?.["u"]);
  if (pendN >= 3) cards.push({ key: "reports_pending", priority: pendN >= 8 ? "high" : "medium", kind: "workflow", title: `${pendN} 則送貨囉貼文還沒對到客戶或車`, why: `待確認 ${num(pend?.["s"])}、無法配對 ${num(pend?.["u"])}；沒對上的成交不會算進業務的成交率、也算不出毛利`, observed: "貼文最常缺車號與客戶名；車牌是對回車源表唯一的鍵", action: "到「待確認配對」逐筆確認；請業務貼文時一定填車號與客戶名", measure: "下週待配對的貼文數", metric_key: "", staff_ids: [], links: [{ label: "待確認配對", href: "/reconcile" }], claim: "fact" });
  // 5. 急迫客戶沒人回
  const stale = await db.first(`SELECT COUNT(*) AS n FROM leads l JOIN funnel_events h ON h.lead_id = l.id AND h.type = 'HIGH_INTENT' WHERE l.outcome = ''
    AND (SELECT MAX(m.created_at) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.lead_id = l.id AND m.sender_role = 'staff') < ?`, new Date(Date.parse(now) - D).toISOString());
  if (num(stale?.["n"]) >= 3) cards.push({ key: "stale_intent", priority: "high", kind: "contact_leads", title: `${num(stale?.["n"])} 位表達急迫的客戶超過 24 小時沒有業務回覆`, why: "急迫客戶等越久，回來的機率越低", observed: obsText("proposed_after_intent", "表現最佳組在客戶表達急迫後多半立刻約看車"), action: "今天把這幾位分回給業務，下班前回報", measure: "24 小時內回覆率", metric_key: "stale_intent", staff_ids: [], links: [{ label: "需要注意", href: "/attention?kind=high_intent_no_followup" }], claim: "fact" });
  // 6. 值得教全隊的成功模式
  const best = report.patterns.filter((p) => p.outcome && p.outcome.lift != null && p.outcome.lift >= 0.15 && p.n_total >= 15 && p.staff.length >= 2).sort((a, b) => (b.outcome!.lift ?? 0) - (a.outcome!.lift ?? 0))[0];
  if (best) cards.push({ key: `pattern_${best.key}`, priority: "medium", kind: "document_pattern", title: `「${best.label}」值得變成團隊做法`, why: `${best.staff.map((s) => s.name).join("、")} 都做到（合計 n=${best.n_total}）`, observed: `有做到的客戶成交率 ${pct(best.outcome!.with.rate)}（n=${best.outcome!.with.n}），沒做到 ${pct(best.outcome!.without.rate)}（n=${best.outcome!.without.n}）—— 關聯，不是因果`, action: "由示範者錄一段 3 分鐘說明＋兩則範例訊息，放進新人教材", measure: "全隊該行為比例", metric_key: best.key, staff_ids: best.staff.map((s) => s.id), links: [{ label: "成功模式庫", href: "/staff#patterns" }], claim: "correlation" });
  // 7. 交接成功率
  for (const tm of report.teams) if (tm.handoff_success.ok && tm.handoff_success.rate != null && tm.handoff_success.rate < 0.4) cards.push({ key: `handoff_${tm.name}`, priority: "low", kind: "review_handoff", title: `${tm.name}交接後成交率只有 ${pct(tm.handoff_success.rate)}`, why: `${tm.handoff_success.n} 件交接中 ${tm.handoff_success.k} 件成交`, observed: "交接時價格與進度沒有一起交", action: "交接一律附：客戶要什麼、談到多少、下一步", measure: "交接後成交率", metric_key: "handoff_success", staff_ids: [], links: [{ label: "團隊效能", href: "/staff#teams" }], claim: "fact" });
  // 8. 表揚
  const top1 = report.top[0];
  if (top1) cards.push({ key: "recognize", priority: "low", kind: "recognize", title: `表揚 ${top1.name}：${top1.reason}`, why: `成交 ${top1.sold} 台、毛利 ${wan(top1.gp)}`, observed: top1.strength, action: "週會公開表揚，並請他分享一個做法", measure: "—", metric_key: "", staff_ids: [top1.staff_id], links: [{ label: "員工檔案", href: `/staff/${top1.staff_id}` }], claim: "fact" });
  const order = { high: 0, medium: 1, low: 2 };
  return cards.sort((a, b) => order[a.priority] - order[b.priority]);
}

/* ── 管理行動：基準快照與前後對照 ── */
const METRIC_LABEL: Record<string, string> = { price_continue: "報價後續走率", appt: "預約轉換", appt_visit: "預約→到店", visit_sale: "到店→成交", close: "成交率", dropoff: "流失率", followup_24h: "沉默後跟進率", first_response: "首次回覆中位數（分鐘）", gp: "毛利", avg_gp: "每台毛利", asked_after_price: "報價後接問題", objection_clarified: "異議後先釐清", proposed_after_intent: "高意圖後約看車", fin_answered: "貸款回答具體", postvisit_24h: "到店後 24h 跟進" };
export function metricSnapshot(report: StaffReport, metricKey: string, staffId: number | null): { key: string; label: string; value: number | null; k: number; n: number; ok: boolean; from: string; to: string } {
  const s = staffId ? report.staff.find((x) => x.id === staffId) : null;
  const fun = s ? s.funnel : report.team.funnel, beh = s ? s.behaviors : report.team.behaviors;
  let m: Metric | NumMetric | null = null; let value: number | null = null;
  if (metricKey in fun) m = (fun as unknown as Record<string, Metric>)[metricKey] ?? null;
  else if (metricKey === "followup_24h") m = s ? s.activity.followup_24h : report.team.activity.followup_24h;
  else if (metricKey === "first_response") m = s ? s.activity.first_response : report.team.activity.first_response;
  else if (metricKey === "gp") value = s ? s.commercial.gp : report.team.commercial.gp;
  else if (metricKey === "avg_gp") m = s ? s.commercial.avg_gp : report.team.commercial.avg_gp;
  else if (metricKey in beh) m = beh[metricKey] ?? null;
  else if (metricKey.startsWith("loss:")) { const r = report.team.loss.reasons.find((x) => x.key === metricKey.slice(5)); return { key: metricKey, label: `流失原因：${r?.label ?? metricKey.slice(5)}`, value: r?.k ?? 0, k: r?.k ?? 0, n: report.team.loss.n, ok: report.team.loss.n >= 5, from: report.period.from, to: report.period.to }; }
  const v = m ? valOf(m) : value;
  return { key: metricKey, label: METRIC_LABEL[metricKey] ?? metricKey, value: v, k: m && isRate(m) ? m.k : 0, n: m ? m.n : 0, ok: m ? m.ok : value != null, from: report.period.from, to: report.period.to };
}
export async function actionProgress(db: DbLike, action: Row, now: string): Promise<{ before: Row | null; after: Row | null; delta: number | null; enough: boolean; days_after: number }> {
  let before: Row | null = null; try { before = JSON.parse(String(action["baseline"] || "null")); } catch { before = null; }
  const key = String(action["metric_key"] || ""); if (!key || !before) return { before, after: null, delta: null, enough: false, days_after: 0 };
  const created = Date.parse(String(action["created_at"])); const daysAfter = Math.max(7, Math.ceil((Date.parse(now) - created) / D));
  const report = await computeStaffReport(db, { days: daysAfter, to: now });
  const after = metricSnapshot(report, key, action["staff_id"] ? num(action["staff_id"]) : null);
  const bv = before["value"] as number | null, av = after.value;
  return { before, after: after as unknown as Row, delta: bv != null && av != null ? r3(av - bv) : null, enough: after.ok && (Date.parse(now) - created) >= 7 * D, days_after: daysAfter };
}
