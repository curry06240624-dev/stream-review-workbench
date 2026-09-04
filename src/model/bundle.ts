/**
 * NormalizedBundle —— 任何來源（模擬器、Super 8 瀏覽器擷取、瑋瑋的表、API）
 * 交給系統的唯一格式。用字串 key 互相參照，匯入時才換成資料庫 id。
 *
 * 這就是 adapter 的輸出契約：模擬器今天產這個，Super 8 adapter 之後也產這個。
 */
import type {
  AppointmentStatus, LeadOutcome, LeadSource, LostReason, MsgType, SenderRole,
  SourceSystem, VisitOutcome,
} from "./types.ts";

export interface BundleStaff { name: string; role: "admin" | "operator" | "agent"; team: string; email: string; }
export interface BundleVehicle {
  key: string; brand: string; model: string; year: number; body_type: string;
  list_price: number; cost: number; stock_status: "in_stock" | "reserved" | "sold";
}
export interface BundleCustomer {
  key: string; display_name: string; pseudonym: string; phone: string; grade: string;
  external_key: string; first_contact_at: string; blocked: 0 | 1;
}
export interface BundleLead {
  key: string; customer_key: string; staff_name: string | null; vehicle_key: string | null;
  source: LeadSource; opened_at: string; closed_at: string | null; outcome: LeadOutcome;
}
export interface BundleMessage { at: string; role: SenderRole; text: string; type?: MsgType; staff_name?: string; }
export interface BundleConversation {
  key: string; customer_key: string; lead_key: string | null; channel: string;
  assigned_staff: string | null; messages: BundleMessage[];
}
export interface BundleAppointment {
  lead_key: string; staff_name: string | null; proposed_at: string; scheduled_for: string | null;
  status: AppointmentStatus; status_at: string;
}
export interface BundleVisit {
  lead_key: string; staff_name: string | null; visited_at: string; outcome: VisitOutcome; note: string;
  after_appointment: boolean;
}
export interface BundleDeal {
  lead_key: string; customer_key: string; staff_name: string | null; vehicle_key: string | null;
  status: "sold" | "lost"; sale_price: number; cost: number; gross_profit: number;
  lost_reason: LostReason | ""; closed_at: string; external_key: string;
}

export interface NormalizedBundle {
  source_system: SourceSystem;
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
}

/** 模擬器另外輸出的「標準答案」：每個 lead 的劇本與該被偵測到的事件，用來量引擎的準確率。 */
export interface TruthLabel {
  lead_key: string;
  scenario: string;
  expect_events: string[];        // 引擎應該偵測到的 FunnelEventType
  price_dropoff: boolean;
  weak_followup: boolean;
}
