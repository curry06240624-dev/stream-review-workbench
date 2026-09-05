/**
 * 資料上傳箱 —— 公司把檔案丟進來（LINE 匯出、車源表／會計 CSV、Super 8 匯出、PDF、截圖），
 * 檔案本體放 Workers KV（免費、與資料庫額度分開），中繼資料放 documents 表。
 *
 * 認得的自動處理：LINE 匯出 .txt → 群組貼文匯入（成交／接待／估車）；bundle .json → 匯入；
 * 車源表 .csv → vehicles 更新；會計成本 .csv → deals.cost（正式成本）。其他先存著、標「待 Curry 處理」。
 * 上傳者可以留備註說這是什麼。刪除只有管理者能按。
 */
import { parseLineExport, detectKind } from "./posts.ts";
import { csvObjects, detectCsvKind, sheetToVehicles, accountingToCosts } from "./csv.ts";

export type DocKind = "line_export" | "bundle" | "sheet_csv" | "accounting_csv" | "roster_csv" | "csv" | "excel" | "pdf" | "image" | "text" | "json" | "other";
export const KIND_LABEL: Record<DocKind, string> = {
  line_export: "LINE 聊天匯出", bundle: "資料包（bundle）", sheet_csv: "車源表 CSV", accounting_csv: "會計成本表 CSV", roster_csv: "員工名冊 CSV",
  csv: "CSV（看不出是哪種表）", excel: "Excel（請另存 CSV）", pdf: "PDF", image: "圖片／截圖", text: "文字檔", json: "JSON", other: "其他",
};
export const AUTO_KINDS: DocKind[] = ["line_export", "sheet_csv", "accounting_csv"];   // 上傳就處理；bundle 要按「匯入」（會動到整個資料庫）
export const PROCESSABLE: DocKind[] = ["line_export", "bundle", "sheet_csv", "accounting_csv"];

const MAX_BYTES = 25 * 1024 * 1024;   // KV 單值上限
export const MAX_FILE_BYTES = MAX_BYTES;

export function decodeText(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > 20 && bad > utf8.length / 200) {
    try { return new TextDecoder("big5").decode(buf); } catch { /* Worker 沒有 big5 就維持 utf-8 */ }
  }
  return utf8;
}

/** 從檔名、MIME、內容判斷種類；forced 是上傳者指定的 */
export function detectDocKind(name: string, mime: string, buf: ArrayBuffer, forced?: string): DocKind {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");
  if (forced && forced !== "auto" && (Object.keys(KIND_LABEL) as string[]).includes(forced)) return forced as DocKind;
  if (["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(ext) || mime.startsWith("image/")) return "image";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (["xlsx", "xls"].includes(ext) || mime.includes("spreadsheet") || mime.includes("excel")) return "excel";
  if (ext === "json" || mime.includes("json")) {
    try { const j = JSON.parse(decodeText(buf.slice(0, 200_000)).replace(/[^]*$/, (s) => s)); return j && j.source_system && Array.isArray(j.conversations) ? "bundle" : "json"; }
    catch { return "json"; }
  }
  if (ext === "csv" || mime.includes("csv")) {
    const { headers } = csvObjects(decodeText(buf.slice(0, 50_000)));
    const k = detectCsvKind(headers);
    return k === "sheet" ? "sheet_csv" : k === "accounting" ? "accounting_csv" : k === "roster" ? "roster_csv" : "csv";
  }
  if (ext === "txt" || mime.startsWith("text/") || !ext) {
    const head = decodeText(buf.slice(0, 20_000));
    const posts = parseLineExport(head);
    if (posts.length >= 1 && /^\d{4}[./\-年]\d{1,2}[./\-月]\d{1,2}/m.test(head)) return "line_export";
    try { const j = JSON.parse(head); if (j && j.source_system) return "bundle"; } catch { /* not json */ }
    return "text";
  }
  return "other";
}

/** 從 KV 讀回內容並處理；db 是 DO 的 stub（RPC） */
export async function processDocument(db: any, kv: KVNamespace, doc: Record<string, unknown>, opts: { now: string; reset?: boolean }): Promise<{ status: "parsed" | "needs_me" | "error"; result: Record<string, unknown> }> {
  const kind = String(doc["kind"]);
  const buf = await kv.get(String(doc["kv_key"]), "arrayBuffer");
  if (!buf) return { status: "error", result: { message: "檔案本體不在儲存空間裡（KV 沒有這個鍵）" } };
  try {
    if (kind === "line_export") {
      const text = decodeText(buf);
      const posts = parseLineExport(text);
      const kinds = { deal: 0, reception: 0, appraisal: 0, unknown: 0 };
      for (const p of posts) kinds[detectKind(p.text)]++;
      const r = await db.ingestGroupLocal({ kind: "auto", posts, source_system: "line_export", now: opts.now });
      return { status: "parsed", result: { posts: posts.length, kinds, deal_reports: r.deal_reports, auto: r.auto, suggested: r.suggested, unmatched: r.unmatched, visits: r.visits, appraisals: r.appraisals, duplicates: r.duplicates, unparsed: r.unparsed.length, warnings: r.warnings.slice(0, 5) } };
    }
    if (kind === "bundle") {
      const b = JSON.parse(decodeText(buf));
      const r = await db.importLocal(b, { reset: !!opts.reset, now: opts.now });
      return { status: "parsed", result: { counts: r.counts, skipped: r.skipped, warnings: (r.warnings || []).slice(0, 5), posts: r.posts ?? null, reset: !!opts.reset } };
    }
    if (kind === "sheet_csv") {
      const { vehicles, skipped, headers } = sheetToVehicles(decodeText(buf));
      if (!vehicles.length) return { status: "needs_me", result: { message: "車源表沒有讀到任何一台車（欄位名對不上？）", headers } };
      const r = await db.vehiclesUpsertLocal({ vehicles, now: opts.now });
      return { status: "parsed", result: { ...r, skipped, headers, no_plate: vehicles.filter((v) => !v.plate_norm).length, no_cost: vehicles.filter((v) => v.cost == null).length } };
    }
    if (kind === "accounting_csv") {
      const { rows, skipped, headers } = accountingToCosts(decodeText(buf));
      if (!rows.length) return { status: "needs_me", result: { message: "會計表沒有讀到任何一列（要有車號、成交日、成本）", headers } };
      const r = await db.accountingCostLocal({ rows, now: opts.now });
      return { status: "parsed", result: { ...r, skipped, headers } };
    }
    return { status: "needs_me", result: { message: `${KIND_LABEL[kind as DocKind] ?? kind}：系統不會自動處理，Curry 會來看` } };
  } catch (e) {
    return { status: "error", result: { message: String((e as Error)?.message || e).slice(0, 300) } };
  }
}

/** 收集進度：哪些資料已經有了 */
export function checklist(docs: Array<Record<string, unknown>>) {
  const has = (f: (d: Record<string, unknown>) => boolean) => docs.some(f);
  const res = (d: Record<string, unknown>): Record<string, unknown> => { const r = d["result"]; if (r && typeof r === "object") return r as Record<string, unknown>; try { return JSON.parse(String(r || "{}")); } catch { return {}; } };
  const lineWith = (key: string) => has((d) => d["kind"] === "line_export" && d["status"] === "parsed" && Number(res(d)?.[key] ?? 0) > 0);
  return [
    { key: "super8", label: "Super 8 對話", done: has((d) => d["kind"] === "bundle" && d["status"] === "parsed"), hint: "MCP 抓的或匯出鈕的檔案，做成 bundle.json 上傳" },
    { key: "deal_group", label: "成交群匯出", done: lineWith("deal_reports"), hint: "LINE 聊天室 › 設定 › 匯出聊天紀錄" },
    { key: "reception_group", label: "接待群匯出", done: lineWith("visits"), hint: "同上" },
    { key: "appraisal_group", label: "估車群匯出", done: lineWith("appraisals"), hint: "同上" },
    { key: "sheet", label: "車源表", done: has((d) => d["kind"] === "sheet_csv" && d["status"] === "parsed"), hint: "Google Sheet › 檔案 › 下載 › CSV" },
    { key: "accounting", label: "會計成本表", done: has((d) => d["kind"] === "accounting_csv" && d["status"] === "parsed"), hint: "車號、成交日、售價、成本" },
    { key: "roster", label: "員工名冊", done: has((d) => d["kind"] === "roster_csv" || /名冊|員工/.test(String(d["name"]) + String(d["note"]))), hint: "姓名、組別、工作性質、暱稱；或直接在資料與設定填" },
    { key: "line_oa", label: "LINE 官方後台匯出", done: has((d) => /官方|OA|後台/i.test(String(d["note"]) + String(d["name"])) ), hint: "補 Super 8 看不到的回覆；備註寫「官方後台」" },
  ];
}
