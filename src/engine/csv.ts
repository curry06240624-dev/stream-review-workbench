/**
 * CSV 讀取與兩種公司表格的欄位對照：車源表（Google Sheet 匯出）與會計月成交成本表。
 * 只認 CSV；Excel 請另存 CSV（Worker 裡不放 xlsx 函式庫）。欄位名寬鬆比對（去空白、全形轉半形、同義詞）。
 */
import { parseMoney, parseYear, normalizePlate, toHalf } from "./posts.ts";

/** RFC 4180 寬鬆版：引號、跳脫引號、CRLF、BOM */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') { q = true; continue; }
    if (c === ",") { row.push(cell); cell = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}
export const normHeader = (h: string) => toHalf(h).replace(/\s+/g, "").replace(/[（(][^）)]*[）)]/g, "").trim();
export function csvObjects(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const all = parseCsv(text); if (!all.length) return { headers: [], rows: [] };
  const headers = all[0]!.map(normHeader);
  const rows = all.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { headers, rows };
}
const pickCol = (headers: string[], names: string[]) => headers.find((h) => names.includes(h)) ?? null;

/* ── 車源表 ── */
const SHEET = {
  plate: ["車牌號碼", "車牌", "車號", "牌照"], year: ["年份", "年式", "出廠年"], brand: ["廠牌", "品牌"], model: ["車型", "車款", "車種"], color: ["顏色", "車色"],
  mileage: ["里程", "里程數", "公里數"], list_price: ["開價", "售價", "定價", "賣價"], cost: ["成本", "進價", "收車價"], status: ["目前狀況", "狀態", "狀況", "車況"],
  stock_in: ["入庫時間", "入庫日期", "入庫", "進庫日"], cert: ["認證狀況", "認證"], trim: ["版本", "等級", "車型等級"], sell_price: ["調作價", "實賣價", "實際售價", "底價"], note: ["備註", "備注", "說明"], repair_note: ["待修備註", "待修"],   // 備註寫「售出 銷售獎金5000」，待修備註是另一欄，分開抓
};
export type SheetVehicle = { plate: string; plate_norm: string; year: number | null; brand: string; model: string; color: string; mileage_km: number | null; list_price: number | null; cost: number | null; stock_status: string; status_text: string; stock_in_at: string | null; cert: string; trim: string; sell_price: number | null; note: string };
export function detectCsvKind(headers: string[]): "sheet" | "accounting" | "roster" | "unknown" {
  const has = (names: string[]) => !!pickCol(headers, names);
  if (has(SHEET.plate) && (has(["成交日", "成交日期", "交車日", "日期"]) && has(SHEET.cost)) && !has(SHEET.stock_in)) return "accounting";
  if (has(SHEET.plate) && (has(SHEET.list_price) || has(SHEET.cost) || has(SHEET.model))) return "sheet";
  if (has(["姓名", "名字", "員工"]) && (has(["暱稱", "LINE暱稱", "工作性質", "組別", "職務"]))) return "roster";
  return "unknown";
}
/* 瑋瑋車源表的寫法（2026-09-06 真檔）：「調作價」＝實賣價（談完真正賣給客戶的價格，Curry 確認），在庫車也會先填；目前狀況「收訂(軒)」「送貸(軒)」「過件(安)」「扣牌中」，括號裡是業務暱稱；備註「售出 銷售獎金5000」 */
const STATUS_MAP: Array<[RegExp, string]> = [[/已售|售出|賣出|交車/, "sold"], [/收訂|已訂|訂金|保留|預訂|送貸|過件|對保/, "reserved"], [/調車|同行|外調/, "peer"], [/在庫|現車|整備|待售|上架|扣牌/, "in_stock"]];
/** 車源表快照比對用的鍵：有車牌用車牌，沒有就 廠牌|車型|年份|顏色（去空白、小寫）。db.js 的 SQL 端要算出一樣的東西 */
export const vehicleKey = (v: { plate_norm: string; brand: string; model: string; year: number | null; color: string }) =>
  v.plate_norm || `${v.brand}|${v.model}|${v.year ?? ""}|${v.color}`.replace(/\s+/g, "").toLowerCase();
/** 車源表把賣掉的車直接刪掉：跟上一份比對，消失的車就標這個（車回到表上會撤銷） */
export const VANISHED_TEXT = "車源表已移除（推定已交車）";
/** 「收訂(軒)」→ 軒 */
export const statusStaff = (s: string) => (s.match(/[（(]([^）)]{1,6})[）)]/)?.[1] ?? "").trim();
/** 日期：2026/07/02、2026-7-2、7/2（當年）、20260702 → ISO（台灣 00:00） */
export function parseDateTw(v: string): string | null {
  const s = toHalf(v).trim(); if (!s) return null;
  let y: number, m: number, d: number;
  let mm = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/); if (mm) { y = Number(mm[1]); m = Number(mm[2]); d = Number(mm[3]); }
  else if ((mm = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = Number(mm[1]); m = Number(mm[2]); d = Number(mm[3]); }
  else if ((mm = s.match(/^(\d{1,2})[./-](\d{1,2})$/))) { y = new Date().getUTCFullYear(); m = Number(mm[1]); d = Number(mm[2]); }
  else if ((mm = s.match(/^(1\d{2})[./-](\d{1,2})[./-](\d{1,2})/))) { y = Number(mm[1]) + 1911; m = Number(mm[2]); d = Number(mm[3]); }   // 民國年
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, m - 1, d) - 8 * 3_600_000).toISOString();
}
export function sheetToVehicles(text: string): { vehicles: SheetVehicle[]; skipped: number; headers: string[] } {
  const { headers, rows } = csvObjects(text);
  const col = Object.fromEntries(Object.entries(SHEET).map(([k, names]) => [k, pickCol(headers, names)])) as Record<keyof typeof SHEET, string | null>;
  const get = (r: Record<string, string>, k: keyof typeof SHEET) => (col[k] ? r[col[k]!] ?? "" : "");
  const out: SheetVehicle[] = []; let skipped = 0;
  for (const r of rows) {
    const plate = get(r, "plate"), model = get(r, "model"), brand = get(r, "brand"), year = parseYear(get(r, "year"));
    if (!plate && !model) { skipped++; continue; }
    if (!normalizePlate(plate) && (!brand || year == null)) { skipped++; continue; }          // 表尾的統計列（在庫／7天內…）沒車牌也沒廠牌年份
    const statusText = get(r, "status"), note = [get(r, "note"), get(r, "repair_note")].filter(Boolean).join(" / ");
    const st = STATUS_MAP.find(([re]) => re.test(statusText))?.[1] ?? (/售出|已售/.test(note) ? "sold" : "in_stock");
    const mile = parseMoney(get(r, "mileage").replace(/km|公里/gi, "").replace(/^[^\d]+/, ""), 0);   // 「里程221135」「里程16萬」
    out.push({
      plate, plate_norm: normalizePlate(plate), year, brand, model, color: get(r, "color"),
      mileage_km: mile == null ? null : (mile < 100 ? mile * 10_000 : mile), list_price: parseMoney(get(r, "list_price"), 1000), cost: parseMoney(get(r, "cost"), 1000),
      stock_status: st, status_text: statusText, stock_in_at: parseDateTw(get(r, "stock_in")), cert: get(r, "cert"), trim: get(r, "trim"), sell_price: parseMoney(get(r, "sell_price"), 1000), note,
    });
  }
  return { vehicles: out, skipped, headers };
}

/* ── 會計月成交成本表 ── */
export type CostRow = { plate: string; plate_norm: string; closed_at: string | null; sale_price: number | null; cost: number | null; staff: string };
export function accountingToCosts(text: string): { rows: CostRow[]; skipped: number; headers: string[] } {
  const { headers, rows } = csvObjects(text);
  const cPlate = pickCol(headers, SHEET.plate), cDate = pickCol(headers, ["成交日", "成交日期", "交車日", "日期"]), cPrice = pickCol(headers, ["售價", "成交價", "賣價"]), cCost = pickCol(headers, SHEET.cost), cStaff = pickCol(headers, ["業務", "銷售", "經手"]);
  const out: CostRow[] = []; let skipped = 0;
  for (const r of rows) {
    const plate = cPlate ? r[cPlate] ?? "" : ""; if (!normalizePlate(plate)) { skipped++; continue; }
    out.push({ plate, plate_norm: normalizePlate(plate), closed_at: cDate ? parseDateTw(r[cDate] ?? "") : null, sale_price: cPrice ? parseMoney(r[cPrice], 1000) : null, cost: cCost ? parseMoney(r[cCost], 1000) : null, staff: cStaff ? r[cStaff] ?? "" : "" });
  }
  return { rows: out, skipped, headers };
}
