/**
 * NormalizedBundle —— 任何來源（模擬器、Super 8 瀏覽器擷取、瑋瑋的表、LINE 群組匯出、API）
 * 交給系統的唯一格式。用字串 key 互相參照，匯入時才換成資料庫 id。
 *
 * 這就是 adapter 的輸出契約：模擬器今天產這個，Super 8 adapter 之後也產這個。
 * 2026-09-05 依瑋瑋公司的真實資料流擴充（docs/DATA_FLOW.md）：
 *   - 員工有工作性質（訊息組／業務）、Super 8 是否共用座位、在各系統的暱稱
 *   - 車輛對齊車源表（車牌、顏色、里程、入庫時間、調作價、同行車）
 *   - 訊息帶來源（Super 8／LINE 官方後台／電話），對話帶涵蓋程度
 *   - 到店可以來自接待群貼文；成交群「送貨囉」貼文與估車群貼文以原文匯入，由引擎解析與配對
 */
import type {
  AppointmentStatus, Coverage, CostSource, LeadOutcome, LeadSource, LostReason, MsgType, SenderRole,
  SourceSystem, StaffJob, VisitOutcome,
} from "./types.ts";

export interface BundleStaff {
  name: string; role: "admin" | "operator" | "agent"; team: string; email: string;
  job?: StaffJob; seat_shared?: 0 | 1;
  /** LINE 群暱稱、Super 8 帳號名、車源表寫法 —— 匯入時全部對回這個人 */
  aliases?: string[];
}
export interface BundleVehicle {
  key: string; brand: string; model: string; year: number; body_type: string;
  list_price: number;
  /** null＝不知道成本（同行的車）：這台的毛利不算 */
  cost: number | null;
  stock_status: "in_stock" | "reserved" | "sold" | "peer";
  plate?: string; color?: string; trim?: string; mileage_km?: number | null; stock_in_at?: string | null; cert?: string;
  trade_price?: number | null; source?: "stock" | "peer"; peer_dealer?: string; status_text?: string;
}
export interface BundleCustomer {
  key: string; display_name: string; pseudonym: string; phone: string; grade: string;
  external_key: string; first_contact_at: string; blocked: 0 | 1;
}
export interface BundleLead {
  key: string; customer_key: string; staff_name: string | null; vehicle_key: string | null;
  source: LeadSource; opened_at: string; closed_at: string | null; outcome: LeadOutcome;
}
export interface BundleMessage { at: string; role: SenderRole; text: string; type?: MsgType; staff_name?: string; via?: "super8" | "line_oa" | "call" | "bot"; }
export interface BundleConversation {
  key: string; customer_key: string; lead_key: string | null; channel: string;
  assigned_staff: string | null; messages: BundleMessage[];
  /** 不給就由匯入器從訊息推（客戶提到電話、只有客戶訊息…） */
  coverage?: Coverage; coverage_note?: string;
}
export interface BundleAppointment {
  lead_key: string; staff_name: string | null; proposed_at: string; scheduled_for: string | null;
  status: AppointmentStatus; status_at: string;
}
export interface BundleVisit {
  lead_key: string; staff_name: string | null; visited_at: string; outcome: VisitOutcome | ""; note: string;
  after_appointment: boolean;
  /** reception＝接待群貼文（權威來源）；ledger＝其他表；chat＝對話推測 */
  source?: "ledger" | "reception" | "chat"; customer_ref?: string; model_text?: string; assigned_by?: string; raw_text?: string;
}
export interface BundleDeal {
  lead_key: string; customer_key: string; staff_name: string | null; vehicle_key: string | null;
  status: "sold" | "lost"; sale_price: number;
  /** null＝沒有成本（同行車／車號空白）；gross_profit 跟著為 null */
  cost: number | null; gross_profit: number | null;
  lost_reason: LostReason | ""; closed_at: string; external_key: string;
  plate?: string; deposit?: "cash" | "transfer" | "none" | "unknown"; loan_status?: "approved" | "rejected" | "none" | "";
  delivery_by?: string; reported_by?: string; source_kind?: "stock" | "peer"; peer_dealer?: string; cost_source?: CostSource;
}
/** 成交群「送貨囉」貼文的原文。引擎自己解析（src/engine/posts.ts），不要在 adapter 先拆欄位，規則才會只有一份。 */
export interface BundleDealReport { key: string; reported_at: string; reported_by: string; raw_text: string; }
/** 估車群貼文原文（只有文字；行照照片不入庫） */
export interface BundleAppraisal { key: string; reported_at: string; reported_by: string; raw_text: string; }

/** 指派／交接紀錄（Super 8 的指派、或瑋瑋公司內部的交接）。沒有這個也能跑：引擎會從對話裡換人發言推定。 */
export interface BundleAssignment { conversation_key: string; from_staff: string | null; to_staff: string; by_staff: string; at: string; }

export interface NormalizedBundle {
  source_system: SourceSystem;
  assignments?: BundleAssignment[];
  generated_at: string;
  teams: string[];
  staff: BundleStaff[];
  vehicles: BundleVehicle[];
  customers: BundleCustomer[];
  leads: BundleLead[];
  conversations: BundleConversation[];
  appointments: BundleAppointment[];
  visits: BundleVisit[];
  deals: BundleDeal[];
  deal_reports?: BundleDealReport[];
  appraisals?: BundleAppraisal[];
}

/** 模擬器另外輸出的「標準答案」：每個 lead 的劇本與該被偵測到的事件，用來量引擎的準確率。 */
export interface TruthLabel {
  lead_key: string;
  scenario: string;
  expect_events: string[];        // 引擎應該偵測到的 FunnelEventType
  price_dropoff: boolean;
  weak_followup: boolean;
  /** 流失原因（引擎的 LossReasonKey）；沒流失就沒有 */
  loss_reason?: string;
  /** 誰在這個 lead 上扮演什麼角色（歸因模型的標準答案） */
  roles?: Array<{ staff: string; role: string }>;
  /** 行為特徵的標準答案（有出現該情境才有鍵） */
  behaviors?: Record<string, boolean>;
  /** 送貨囉貼文的配對標準答案：這個 lead 的貼文應該對到哪台車（key）；沒貼文就沒有 */
  report?: { key: string; vehicle_key: string | null; expect: "auto" | "suggested" | "unmatched"; at: string; sender: string };
}
