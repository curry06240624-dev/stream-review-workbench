/* 管理行動：從決策卡／教練建議建立行動（伺服器存基準快照），之後比前後。系統只記錄與衡量，不代發任何訊息。 */
import { api } from "./api.js";
import { toast } from "./ui.js";

const METRIC_OF = { response: "first_response", followup: "followup_24h", price_continue: "price_continue", close: "close", appt: "appt", appt_visit: "appt_visit", visit_sale: "visit_sale" };
export const metricKeyFor = (issueKey) => METRIC_OF[issueKey] || issueKey || "";

export async function createAction(p) {
  const r = await api("/api/mgmt-actions", {
    kind: p.kind || "coach", title: p.title, staff_id: p.staff_id ?? null, priority: p.priority || "medium", metric_key: p.metric_key || "",
    why: p.why || "", measure: p.measure || "", action: p.action || p.title, due_days: p.due_days || 30, owner_role: p.owner_role || "manager", insight_id: p.insight_id ?? null,
  });
  toast(r.ok ? `已建立行動 #${r.id}${r.baseline && r.baseline.value != null ? "，基準指標已存" : ""}` : (r.message || "建立失敗"));
  return r;
}

export async function updateAction(id, body) {
  const r = await api(`/api/mgmt-actions/${id}`, body, "PATCH");
  toast(r.ok ? "已更新" : (r.message || "更新失敗"));
  return r;
}
