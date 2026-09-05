/**
 * 內部資料模型 —— 整套系統唯一認得的形狀。
 *
 * 資料從哪裡來（模擬產生器、Super 8 瀏覽器擷取、瑋瑋的表格、之後的 API）
 * 都要先經過 adapter 變成這裡的型別；漏斗引擎、分析、AI、畫面一律只看這裡。
 * 這是「不跟 Super 8 綁死」的具體實作，不是口號。
 */

/* ── 共用列舉 ─────────────────────────────────────────── */

/** AI 或規則下結論時的把握程度。畫面上一定要顯示，不能只給結論。 */
export type Confidence = "CONFIRMED" | "STRONGLY_SUGGESTED" | "POSSIBLE" | "UNCLEAR";

/** 一句話是事實、相關、還是假設。CEO 簡報裡三者要分開寫。 */
export type Claim = "fact" | "correlation" | "hypothesis";

export type Severity = "critical" | "high" | "medium" | "low";

export type SenderRole = "customer" | "staff" | "bot" | "system";

export type MsgType = "text" | "image" | "video" | "audio" | "file" | "location" | "sticker" | "unknown";

export type LeadSource = "meta" | "ig" | "line_search" | "referral" | "walk_in" | "unknown";

export type LeadOutcome = "" | "sold" | "lost";

export type AppointmentStatus =
  | "proposed" | "booked" | "rescheduled" | "cancelled" | "no_show" | "completed";

export type VisitOutcome = "negotiating" | "bought" | "left" | "followup";

export type LostReason =
  | "price" | "financing" | "competitor" | "no_response" | "changed_mind" | "vehicle_gone" | "other"
  | "vehicle_condition" | "vehicle_mismatch" | "trade_in" | "timing" | "family" | "no_stock" | "browsing";

/** 一位員工在一個 lead 上的角色（歸因模型，見 docs/STAFF_EFFECTIVENESS.md §1）
 *  chat_handler＝訊息組：線上聊天由他回，到店後才交給業務（瑋瑋公司的實際流程，見 docs/DATA_FLOW.md） */
export type LeadRole = "primary" | "supporting" | "manager" | "handoff_from" | "handoff_to" | "reactivation" | "chat_handler";

/** 員工的工作性質：chat＝訊息組（回線上訊息）、sales＝業務（到店接待、成交）、both＝兩者都做、manager＝主管 */
export type StaffJob = "chat" | "sales" | "both" | "manager";

/** 一段對話的訊息涵蓋程度：full＝雙方訊息都在；partial＝有跡象顯示有電話或官方後台回覆不在紀錄裡；low＝幾乎只有客戶訊息 */
export type Coverage = "full" | "partial" | "low";

/** 成交的成本從哪來：ledger＝帳本直接給、sheet＝車源表的成本（估算）、accounting＝會計、none＝沒有（同行車、車號空白） */
export type CostSource = "ledger" | "sheet" | "accounting" | "none";

/** 成交群貼文（送貨囉）的配對狀態 */
export type MatchStatus = "auto" | "suggested" | "unmatched" | "confirmed" | "rejected";

/** 流失原因分類（引擎用的鍵；帳本的 LostReason 會對應進來） */
export type LossReasonKey =
  | "price_resistance" | "financing" | "vehicle_mismatch" | "vehicle_condition" | "trade_in" | "timing" | "family"
  | "bought_elsewhere" | "no_stock" | "slow_response" | "weak_followup" | "no_show" | "stopped_replying" | "browsing"
  | "negotiation_failed" | "other" | "unclear";

/** 漏斗事件。順序大致就是客戶旅程，但同一個 lead 可以來回（例如流失後又回來）。 */
export type FunnelEventType =
  | "NEW_LEAD"
  | "VEHICLE_INTEREST"
  | "ACTIVE_DISCUSSION"
  | "PRICE_MENTIONED"
  | "PRICE_OBJECTION"
  | "PRICE_DROP_OFF"
  | "FINANCING_QUESTION"
  | "APPOINTMENT_PROPOSED"
  | "APPOINTMENT_BOOKED"
  | "APPOINTMENT_CHANGED"
  | "APPOINTMENT_CANCELLED"
  | "NO_SHOW"
  | "STORE_VISIT"
  | "NEGOTIATION"
  | "FOLLOW_UP"
  | "HIGH_INTENT"
  | "CUSTOMER_INACTIVE"
  | "RE_ENGAGED"
  | "SOLD"
  | "LOST";

/** 事件是誰判定的：規則、AI、成交帳本、人工。稽核與信任都靠這個欄位。 */
export type EventSource = "rule" | "ai" | "ledger" | "manual";

export type InsightKind =
  | "price_dropoff" | "funnel_stage" | "appointment" | "visit" | "followup"
  | "vehicle" | "staff" | "financing" | "anomaly" | "opportunity";

export type ActionStatus = "proposed" | "approved" | "dismissed" | "done";

export type SourceSystem = "mock" | "super8_browser" | "super8_export" | "sheet" | "api" | "line_export";

/* ── 實體 ─────────────────────────────────────────────── */

export interface Team { id: number; name: string; }

export interface Staff {
  id: number; name: string; role: "admin" | "operator" | "agent";
  team_id: number | null;
  job: StaffJob | "";               // 空字串＝依 role 推：agent→both、其他→manager
  seat_shared: 0 | 1;               // Super 8 座位是借來／共用的：個人的訊息指標不可信，只算到團隊
}

/** 員工在各系統的名字：LINE 群暱稱（火箭、梨子）、Super 8 帳號名、車源表寫法。匯入時全部對回同一個 user。 */
export interface StaffAlias { id: number; user_id: number; alias: string; system: "line" | "super8" | "sheet" | ""; }

/** 客戶。主鍵是我們自己的 id；`external_key` 是對回瑋瑋表格的鍵（電話或 LINE 名稱），
 *  `pseudonym` 是去識別化後對外顯示的名字。真資料進來時 display_name 就存假名。 */
export interface Customer {
  id: number;
  display_name: string;
  pseudonym: string;
  phone: string;
  grade: string;               // S | A | B | B+ | C —— 公司自己的分級，不強制列舉
  external_key: string;
  first_contact_at: string | null;
  blocked: 0 | 1;
  source_system: SourceSystem;
}

/** 車輛主檔。欄位對齊瑋瑋公司的車源表（Google Sheet）：入庫時間／年份／車型／廠牌／車牌號碼／顏色／里程／認證狀況／版本／開價／調作價／成本。
 *  同行的車（調車、不在車源表）source='peer'，成本通常不知道：cost_known=0，這台的毛利就不算。 */
export interface Vehicle {
  id: number;
  brand: string; model: string; year: number | null;
  body_type: "sedan" | "suv" | "hatch" | "mpv" | "pickup" | "";
  list_price: number;          // 元（車源表「開價」）
  cost: number;                // 進車成本（車源表「成本」），毛利＝售價－成本；cost_known=0 時這個值沒有意義
  cost_known: 0 | 1;
  stock_status: "in_stock" | "reserved" | "sold" | "peer";
  external_id: string;
  plate: string;               // 車牌號碼：成交群貼文對回車源表唯一的鍵
  plate_norm: string;          // 去掉「-」與空白、全大寫，配對用
  color: string; trim: string; mileage_km: number | null; stock_in_at: string | null; cert: string;
  trade_price: number | null;  // 車源表「調作價」（欄位意義待瑋瑋確認）
  source: "stock" | "peer"; peer_dealer: string; status_text: string;
}

/** 一段購車旅程。一個客戶可以有多個 lead（例如半年後又來），一個 lead 可跨多個對話。 */
export interface Lead {
  id: number;
  contact_id: number;
  staff_id: number | null;
  vehicle_id: number | null;
  source: LeadSource;
  stage: string;               // 引擎推算的目前階段，可重算
  outcome: LeadOutcome;
  opened_at: string;
  closed_at: string | null;
}

export interface Conversation {
  id: number;
  contact_id: number;
  lead_id: number | null;
  channel: string;             // line | fb | ig
  assigned_to: number | null;
  status: "open" | "closed";
  last_message_at: string;
  external_id: string;
  coverage: Coverage;          // 訊息涵蓋：不完整時引擎不准說「回覆太慢」「跟進不足」
  coverage_note: string;
}

export interface Message {
  id: number;
  conversation_id: number;
  direction: "in" | "out";
  sender_role: SenderRole;
  sender_user_id: number | null;
  msg_type: MsgType;
  text: string;
  created_at: string;
  external_id: string;
  via: "super8" | "line_oa" | "call" | "bot" | "";   // 從哪個系統來：Super 8 看不到官方後台打的字與電話
}

export interface Appointment {
  id: number;
  lead_id: number;
  staff_id: number | null;
  proposed_at: string;
  scheduled_for: string | null;
  status: AppointmentStatus;
  status_at: string;
  evidence_message_id: number | null;
}

/** 到店。真實來源是接待群貼文（客戶名／車款／到店時間／誰指派）：source='reception'。
 *  有接待群資料時，對話裡推測的到店一律降為「不確定」，不進轉換率。 */
export interface Visit {
  id: number;
  lead_id: number;
  appointment_id: number | null;
  staff_id: number | null;     // 接待群「誰指派」的業務
  visited_at: string;
  outcome: VisitOutcome | "";
  note: string;
  source: "ledger" | "reception" | "chat";
  customer_ref: string; model_text: string; assigned_by: string; raw_text: string;
}

/** 成交／流失帳本。真實來源是成交群的「送貨囉」貼文（見 DealReport）配對後產生；
 *  毛利只有會計有正式數字，這裡的毛利是「售價－車源表成本」的估算（gp_is_estimate=1），沒有成本就不算（cost_source='none'）。 */
export interface Deal {
  id: number;
  lead_id: number | null;
  contact_id: number;
  staff_id: number | null;
  vehicle_id: number | null;
  status: "sold" | "lost";
  sale_price: number;
  cost: number;
  gross_profit: number;        // cost_source='none' 時為 0 且無意義，統計一律用 cost_source 過濾
  lost_reason: LostReason | "";
  closed_at: string;
  external_key: string;
  source_system: SourceSystem;
  plate: string; customer_ref: string;
  deposit: "cash" | "transfer" | "none" | "unknown" | "";
  loan_status: "approved" | "rejected" | "none" | "";
  delivery_by: string; reported_by: string;
  source_kind: "stock" | "peer"; peer_dealer: string;
  cost_source: CostSource; gp_is_estimate: 0 | 1;
  report_id: number | null;    // 來自哪一則送貨囉貼文
}

/** 成交群「送貨囉」貼文：解析出的欄位＋配對狀態。老闆在「待確認配對」頁確認後才變成 Deal。 */
export interface DealReport {
  id: number;
  reported_at: string; reported_by: string; reported_by_user_id: number | null;
  year: number | null; model_text: string; color: string; plate: string; plate_norm: string;
  deposit: Deal["deposit"]; sale_price: number | null;
  source_kind: "stock" | "peer" | ""; peer_dealer: string;
  delivery_by: string; delivery_uncertain: 0 | 1; note: string; loan_status: Deal["loan_status"];
  customer_ref: string; staff_ref: string; raw_text: string;
  missing: string[];           // 缺哪些必要欄位（車號、售價、客戶、業務）
  match_status: MatchStatus; match_method: "plate" | "fuzzy" | "customer" | "manual" | "";
  match_confidence: Confidence | ""; match_reasons: string[];
  vehicle_id: number | null; lead_id: number | null; contact_id: number | null; staff_id: number | null;
  candidates: { vehicles: Array<{ id: number; label: string; reason: string }>; leads: Array<{ id: number; label: string; reason: string }> };
  deal_id: number | null; deal_created: 0 | 1;
  source_system: SourceSystem; external_id: string; created_at: string;
  confirmed_by: number | null; confirmed_at: string | null;
}

/** 估車群貼文：車型／年份／版本／顏色／里程／權威／天書／車換車 or 純賣／客人理想價格。行照照片永遠不入庫。 */
export interface Appraisal {
  id: number;
  reported_at: string; reported_by: string; reported_by_user_id: number | null;
  model_text: string; year: number | null; trim: string; color: string; mileage_km: number | null;
  book_quanwei: number | null; book_tianshu: number | null;   // 元
  mode: "trade_in" | "sell" | ""; customer_ask: number | null; customer_ref: string;
  lead_id: number | null; contact_id: number | null; raw_text: string;
  source_system: SourceSystem; external_id: string; created_at: string;
}

/** 內部群組的每一則貼文都先落這裡（稽核用），解析成功才連到 deal_reports／visits／appraisals */
export interface GroupPost {
  id: number; kind: "deal" | "reception" | "appraisal" | "unknown"; at: string; sender: string; text: string;
  status: "parsed" | "unmatched" | "ignored"; ref_table: string; ref_id: number | null; note: string;
  source_system: SourceSystem; external_id: string; created_at: string;
}

export interface FunnelEvent {
  id: number;
  lead_id: number;
  conversation_id: number | null;
  contact_id: number;
  staff_id: number | null;
  vehicle_id: number | null;
  type: FunnelEventType;
  at: string;
  confidence: Confidence;
  source: EventSource;
  detail: Record<string, unknown>;
}

/** 證據＝指向一則訊息的指標＋一句「為什麼這段支持結論」。沒有證據的洞察不准上畫面。 */
export interface Evidence {
  id: number;
  event_id: number | null;
  insight_id: number | null;
  message_id: number | null;
  lead_id: number | null;
  note: string;
}

export interface Insight {
  id: number;
  kind: InsightKind;
  title: string;
  summary: string;
  claim: Claim;
  severity: Severity;
  confidence: Confidence;
  metric: { value?: number; delta?: number; n?: number; baseline?: number; unit?: string };
  period_from: string | null;
  period_to: string | null;
  created_at: string;
  dismissed: 0 | 1;
}

export interface RecommendedAction {
  id: number;
  insight_id: number | null;
  text: string;
  owner_role: "ceo" | "manager" | "staff" | "";
  status: ActionStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: number | null;
  result_note: string;         // 「上次的動作有沒有用」寫這裡，這是閉環的最後一格
}

export interface DailyBrief {
  id: number;
  brief_date: string;          // YYYY-MM-DD，台灣日期
  content: BriefContent;
  model: string;
  created_at: string;
}

/** CEO 每日簡報的八個問題。每一題都要能點到 insight，所以帶 ids。 */
export interface BriefContent {
  happened: string; changed: string; good: string; bad: string;
  unusual: string; why: string; attention: string; do_today: string;
  insight_ids: number[];
}

/** 溯源：這筆資料從哪個系統、哪個原始鍵來。去識別化稽核與重複匯入都靠它。 */
export interface SourceRecord {
  id: number;
  source_system: SourceSystem;
  entity: "contact" | "conversation" | "message" | "deal" | "vehicle";
  entity_id: number;
  external_id: string;
  captured_at: string;
  raw_hash: string;
}
