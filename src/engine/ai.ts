/**
 * AI 敘事層 —— 只做三件事：解釋、假設、建議。數字全部來自分析層，AI 不算數。
 *
 * 防唬爛的三道閘：
 *   1. 事實包（facts pack）：AI 只能引用我們給它的數字。回來的文字裡出現事實包沒有的百分比或金額 → 整段退回，用模板。
 *   2. 洞察 id 白名單：AI 引用的 insight id 不存在 → 丟掉那句。
 *   3. 假設要標明：AI 寫的「為什麼」一律存成「假設：…」，畫面上跟事實分開顯示。
 *
 * 沒有 GEMINI_API_KEY、或呼叫失敗 → 全部退回決定性模板。展示現場不能靠一次 API 呼叫成功。
 */
import type { Analytics } from "./analytics.ts";
import type { DbLike } from "../adapters/import.ts";
import type { BriefContent } from "../model/types.ts";
import type { CoachingPlan } from "./coaching.ts";

type Row = Record<string, unknown>;
interface Env { GEMINI_API_KEY?: string; GEMINI_MODEL?: string; }

/* ── Gemini 呼叫（JSON 模式）── */
export async function gemini(env: Env, prompt: string): Promise<unknown> {
  if (!env.GEMINI_API_KEY) throw new Error("no_key");
  const model = env.GEMINI_MODEL || "gemini-3.7-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: "application/json" } }),
  });
  if (!r.ok) throw new Error(`gemini_${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
  const data = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
}

/* ── 閘門 1：數字白名單 ── */
export const numbersIn = (s: string) => new Set((s.match(/\d+(?:\.\d+)?/g) ?? []).map((x) => x.replace(/^0+(?=\d)/, "")));
export function factsPack(a: Analytics, insights: Row[]): { text: string; allowed: Set<string> } {
  const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const lines = [
    `期間：最近 ${a.period.days} 天（${a.period.from.slice(0, 10)} ～ ${a.period.to.slice(0, 10)}），對照前 ${a.period.days} 天`,
    `新進線 ${a.funnel.leads}（前期 ${a.funnel.prev_leads}）`,
    `報價 ${a.price_dropoff.base} 次，價格後流失 ${a.price_dropoff.count} 位＝${pct(a.price_dropoff.rate)}（前期 ${pct(a.price_dropoff.prev_rate)}）`,
    `報價→預約 ${pct(a.conversion["price_to_booking"]?.rate)}（n=${a.conversion["price_to_booking"]?.n}）；預約→到店 ${pct(a.conversion["booking_to_visit"]?.rate)}（n=${a.conversion["booking_to_visit"]?.n}）；到店→成交 ${pct(a.conversion["visit_to_sold"]?.rate)}（n=${a.conversion["visit_to_sold"]?.n}）`,
    `預約：提議 ${a.appointments["proposed"]}、成立 ${a.appointments["booked"]}、爽約 ${a.appointments["no_show"]}（爽約率 ${pct(a.appointments["no_show_rate"])}）`,
    `到店 ${a.visits["count"]}（前期 ${a.visits["prev_count"]}）`,
    `成交 ${a.deals.sold} 台（前期 ${a.deals.prev_sold}）、營收 ${Math.round(a.deals.revenue / 10000)} 萬、毛利 ${Math.round(a.deals.gross_profit / 10000)} 萬、毛利率 ${pct(a.deals.gp_margin)}、低於成本 ${a.deals.below_cost} 筆${a.deals.sheet_sold ? `（其中 ${a.deals.sheet_sold} 筆來自車源表的售出）` : ""}；成交裡 ${a.deals.undelivered} 台還沒交車（車源表 收訂／送貸／過件，${Math.round(a.deals.undelivered_amount / 10000)} 萬；收訂就算成交）`,
    `需要注意：${a.attention.length} 位（急迫未跟進 ${a.attention.filter((x) => x.kind === "high_intent_no_followup").length}、報價後未跟進 ${a.attention.filter((x) => x.kind === "price_dropoff_no_followup").length}、預約未到店 ${a.attention.filter((x) => x.kind === "booked_but_no_visit").length}、貸款未回 ${a.attention.filter((x) => x.kind === "financing_unresolved").length}）`,
    "",
    "已成立的洞察（id｜嚴重度｜標題｜摘要）：",
    ...insights.map((i) => `#${i["id"]}｜${i["severity"]}｜${i["title"]}｜${i["summary"]}`),
  ];
  const text = lines.join("\n");
  return { text, allowed: numbersIn(text) };
}
export const violates = (s: string, allowed: Set<string>) => [...numbersIn(s)].some((n) => !allowed.has(n) && !/^\d{1,2}$/.test(n)); // 1–2 位小數字（例如「3 位」）放行

/* ── 敘事：每條洞察補「為什麼（假設）」與建議 ── */
export async function narrateInsights(db: DbLike, env: Env, a: Analytics, now: string): Promise<{ narrated: number; mode: "ai" | "template" }> {
  const insights = await db.all("SELECT id, kind, title, summary, severity, claim FROM insights WHERE period_from = ? AND period_to = ? AND dismissed = 0 ORDER BY id", a.period.from, a.period.to);
  if (!insights.length) return { narrated: 0, mode: "template" };
  const { text, allowed } = factsPack(a, insights);
  const prompt = `你是中古車公司的資深銷售營運顧問，面對的是老闆。下面是系統從 LINE 對話算出來的數字與已成立的洞察。

你的任務：對每一條洞察，用繁體中文寫
  "why"：一個最可能的原因（這是假設，不是事實），最多兩句，不要重複標題已經講的數字
  "actions"：最多兩個明天就能做的具體動作，每個註明誰做（ceo / manager / staff）
規則：
  - 只能引用下面事實包裡出現過的數字，不准自己算、不准編新的百分比
  - 不確定就說「可能」，不要把假設寫成結論
  - 語氣像顧問跟老闆講話，不要客套

嚴格輸出 JSON：{"items":[{"id":數字,"why":"…","actions":[{"text":"…","owner_role":"manager"}]}]}

【事實包】
${text}`;
  let parsed: { items?: Array<{ id: number; why?: string; actions?: Array<{ text: string; owner_role: string }> }> };
  try { parsed = await gemini(env, prompt) as typeof parsed; }
  catch { return { narrated: 0, mode: "template" }; }
  const valid = new Set(insights.map((i) => Number(i["id"])));
  let n = 0;
  for (const it of parsed.items ?? []) {
    if (!valid.has(Number(it.id))) continue;                       // 閘門 2
    const why = String(it.why ?? "").slice(0, 300);
    if (!why || violates(why, allowed)) continue;                   // 閘門 1
    const cur = insights.find((i) => Number(i["id"]) === Number(it.id))!;
    const base = String(cur["summary"]).replace(/\n假設：[\s\S]*$/, "");
    await db.run("UPDATE insights SET summary = ? WHERE id = ?", `${base}\n假設：${why}`, it.id);   // 閘門 3
    const acts = (it.actions ?? []).slice(0, 2).filter((x) => x.text && !violates(x.text, allowed));
    if (acts.length) {
      await db.run("DELETE FROM actions WHERE insight_id = ? AND status = 'proposed'", it.id);
      for (const x of acts) await db.run("INSERT INTO actions (insight_id, text, owner_role, status, created_at) VALUES (?,?,?,'proposed',?)", it.id, String(x.text).slice(0, 300), ["ceo", "manager", "staff"].includes(x.owner_role) ? x.owner_role : "manager", now);
    }
    n++;
  }
  return { narrated: n, mode: "ai" };
}

/* ── CEO 每日簡報 ── */
export async function generateBrief(db: DbLike, env: Env, a: Analytics, date: string, now: string): Promise<{ content: BriefContent; mode: "ai" | "template"; model: string }> {
  const insights = await db.all("SELECT id, kind, title, summary, severity, claim FROM insights WHERE period_from = ? AND period_to = ? AND dismissed = 0 ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id", a.period.from, a.period.to);
  const { text, allowed } = factsPack(a, insights);
  const ids = insights.map((i) => Number(i["id"]));
  const template = templateBrief(a, insights);
  if (!env.GEMINI_API_KEY) return { content: template, mode: "template", model: "" };

  const prompt = `你是中古車公司老闆的幕僚。用下面的事實包寫一份「30 秒讀完」的每日簡報，繁體中文，每一題最多兩句話。
八題：happened（發生什麼）、changed（跟前期比變了什麼）、good、bad、unusual（異常）、why（最可能的原因，標明是推測）、attention（今天最該看的一件事）、do_today（今天該做的一個動作）。
規則：只能用事實包裡的數字；不要列清單、不要標題、不要客套；引用洞察時用 #id。
嚴格輸出 JSON：{"happened":"…","changed":"…","good":"…","bad":"…","unusual":"…","why":"…","attention":"…","do_today":"…","insight_ids":[數字]}

【事實包】
${text}`;
  try {
    const p = await gemini(env, prompt) as Partial<BriefContent>;
    const keys: Array<keyof Omit<BriefContent, "insight_ids">> = ["happened", "changed", "good", "bad", "unusual", "why", "attention", "do_today"];
    const content: BriefContent = { ...template };
    for (const k of keys) {
      const v = String(p[k] ?? "").slice(0, 240);
      if (v && !violates(v, allowed)) content[k] = v;              // 有假數字的那題退回模板，其餘照用
    }
    content.insight_ids = (Array.isArray(p.insight_ids) ? p.insight_ids.map(Number) : []).filter((x) => ids.includes(x));
    if (!content.insight_ids.length) content.insight_ids = ids.slice(0, 3);
    const model = env.GEMINI_MODEL || "gemini-3.7-flash";
    await db.run(`INSERT INTO briefs (brief_date, content, model, created_at) VALUES (?,?,?,?) ON CONFLICT(brief_date) DO UPDATE SET content = excluded.content, model = excluded.model, created_at = excluded.created_at`, date, JSON.stringify(content), model, now);
    return { content, mode: "ai", model };
  } catch {
    await db.run(`INSERT INTO briefs (brief_date, content, model, created_at) VALUES (?,?,?,?) ON CONFLICT(brief_date) DO UPDATE SET content = excluded.content, model = excluded.model, created_at = excluded.created_at`, date, JSON.stringify(template), "template", now);
    return { content: template, mode: "template", model: "template" };
  }
}

/** 沒有 AI 也要能出簡報：從數字直接組句子 */
function templateBrief(a: Analytics, insights: Row[]): BriefContent {
  const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const top = insights[0], sec = insights[1];
  const dSold = a.deals.sold - a.deals.prev_sold, dLeads = a.funnel.leads - a.funnel.prev_leads;
  const worst = Object.entries(a.conversion).filter(([, v]) => v.n >= 8 && v.rate != null).sort((x, y) => (x[1].rate ?? 1) - (y[1].rate ?? 1))[0];
  const label: Record<string, string> = { price_to_booking: "報價→預約", booking_to_visit: "預約→到店", visit_to_sold: "到店→成交", lead_to_sold: "進線→成交", price_to_sold: "報價→成交" };
  return {
    happened: `最近 ${a.period.days} 天新進線 ${a.funnel.leads} 位，報價 ${a.price_dropoff.base} 次，成交 ${a.deals.sold} 台、毛利 ${Math.round(a.deals.gross_profit / 10000)} 萬。`,
    changed: `成交${dSold >= 0 ? "多" : "少"}了 ${Math.abs(dSold)} 台，進線${dLeads >= 0 ? "多" : "少"}了 ${Math.abs(dLeads)} 位；價格後流失率 ${pct(a.price_dropoff.rate)}（前期 ${pct(a.price_dropoff.prev_rate)}）。`,
    good: a.deals.sold ? `到店→成交 ${pct(a.conversion["visit_to_sold"]?.rate)}，來店的客人多數有買。` : "本期沒有成交，好消息要等。",
    bad: worst ? `${label[worst[0]] ?? worst[0]} 只有 ${pct(worst[1].rate)}（n=${worst[1].n}），是漏斗最弱的一段。` : "樣本不足，還看不出最弱的一段。",
    unusual: a.deals.below_cost ? `有 ${a.deals.below_cost} 筆成交低於成本。` : (a.appointments["no_show"] ?? 0) >= 3 ? `爽約 ${a.appointments["no_show"]} 位。` : "沒有明顯異常。",
    why: top ? `（推測）${String(top["title"])} 可能是主因，詳見 #${top["id"]}。` : "（推測）目前沒有足夠的證據指出單一原因。",
    attention: top ? `#${top["id"]} ${String(top["title"])}` : `需要注意的 ${a.attention.length} 位客戶。`,
    do_today: a.attention.find((x) => x.kind === "high_intent_no_followup") ? `先把 ${a.attention.filter((x) => x.kind === "high_intent_no_followup").length} 位急迫但沒人跟進的客戶分回給業務，今天回。` : sec ? `處理 #${sec["id"]}。` : "看一遍需要注意清單。",
    insight_ids: insights.slice(0, 3).map((i) => Number(i["id"])),
  };
}

/* ── 教練計畫潤稿：只改寫建議句與範例訊息的語氣；數字白名單照舊，不准新增數字；失敗就留規則版 ── */
export async function polishCoaching(env: Env, plan: CoachingPlan): Promise<CoachingPlan> {
  if (!env.GEMINI_API_KEY || (!plan.changes.length && !plan.message_examples.length)) return plan;
  const allowed = numbersIn(JSON.stringify(plan));
  const prompt = `你是中古車公司的銷售教練。下面是系統從對話算出來的教練建議（規則版）。請用繁體中文、像資深主管跟業務講話的語氣改寫：
  - "changes"：每條建議改寫成更具體、可執行的一句話（保留原意，不新增任何數字或百分比）
  - "examples"：每則建議訊息改寫成更自然的 LINE 口吻（台灣中古車業務的語氣，可用「!!」「～」），價格與數字不能改
嚴格輸出 JSON：{"changes":["…"],"examples":["…"]}，陣列長度要跟輸入一樣。
【建議】${JSON.stringify(plan.changes.map((c) => c.text))}
【範例訊息】${JSON.stringify(plan.message_examples.map((e) => e.suggested))}`;
  try {
    const p = await gemini(env, prompt) as { changes?: string[]; examples?: string[] };
    const out: CoachingPlan = { ...plan, changes: plan.changes.map((c) => ({ ...c })), message_examples: plan.message_examples.map((e) => ({ ...e })) };
    let used = false;
    (p.changes ?? []).forEach((t, i) => { const s = String(t).slice(0, 200); const c = out.changes[i]; if (c && s && !violates(s, allowed)) { c.text = s; used = true; } });
    (p.examples ?? []).forEach((t, i) => { const s = String(t).slice(0, 300); const e = out.message_examples[i]; if (e && s && !violates(s, allowed)) { e.suggested = s; used = true; } });
    out.model = used ? (env.GEMINI_MODEL || "gemini-3.7-flash") : "template";
    return out;
  } catch { return plan; }
}
