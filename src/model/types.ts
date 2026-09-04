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
  | "price" | "financing" | "competitor" | "no_response" | "changed_mind" | "vehicle_gone" | "other";

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

export type SourceSystem = "mock" | "super8_browser" | "super8_export" | "sheet" | "api";

/* ── 實體 ─────────────────────────────────────────────── */

export interface Team { id: number; name: string; }

export interface Staff {
  id: number; name: string; role: "admin" | "operator" | "agent";
  team_id: number | null;
}

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

export interface Vehicle {
  id: number;
  brand: string; model: string; year: number | null;
  body_type: "sedan" | "suv" | "hatch" | "mpv" | "pickup" | "";
  list_price: number;          // 元
  cost: number;                // 進車成本，毛利＝售價－成本
  stock_status: "in_stock" | "reserved" | "sold";
  external_id: string;
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

export interface Visit {
  id: number;
  lead_id: number;
  appointment_id: number | null;
  staff_id: number | null;
  visited_at: string;
  outcome: VisitOutcome;
  note: string;
}

/** 成交／流失帳本。形狀刻意對齊「一張試算表的一列」，因為真實來源就是瑋瑋的表。 */
export interface Deal {
  id: number;
  lead_id: number | null;
  contact_id: number;
  staff_id: number | null;
  vehicle_id: number | null;
  status: "sold" | "lost";
  sale_price: number;
  cost: number;
  gross_profit: number;
  lost_reason: LostReason | "";
  closed_at: string;
  external_key: string;
  source_system: SourceSystem;
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
