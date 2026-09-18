/**
 * 把 LINE 群組匯出 .txt（`2026.08.05 星期三` 日期行 ＋ `HH:MM<tab>發文人<tab>內容`）切成只留某一段期間的版本。
 *   node scripts/adapters/group_txt_slice.mjs <in.txt> <out.txt> --from=2026-08-01 --to=2026-09-01
 * 日期行之前的檔頭（[LINE] 與 … 的聊天記錄／儲存日期）不保留；期間外的日期整段跳過。只印天數與行數。
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const [inFile, outFile] = args.filter((a) => !a.startsWith("--"));
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).slice(k.length + 3);
if (!inFile || !outFile) { console.error("用法：node scripts/adapters/group_txt_slice.mjs <in.txt> <out.txt> --from=YYYY-MM-DD --to=YYYY-MM-DD"); process.exit(2); }
const from = opt("from", "").replace(/-/g, "."), to = opt("to", "").replace(/-/g, ".");
if (!/^\d{4}\.\d{2}\.\d{2}$/.test(from) || !/^\d{4}\.\d{2}\.\d{2}$/.test(to)) { console.error("--from／--to 要是 YYYY-MM-DD"); process.exit(2); }

const lines = readFileSync(inFile, "utf8").replace(/^﻿/, "").split(/\r?\n/);
const out = []; let keep = false, days = 0, daysAll = 0;
for (const ln of lines) {
  const m = ln.match(/^(\d{4}\.\d{2}\.\d{2})\s/);
  if (m) { daysAll++; keep = m[1] >= from && m[1] < to; if (keep) days++; }
  if (keep) out.push(ln);
}
writeFileSync(outFile, out.join("\n") + "\n");
console.log(`${inFile}：${daysAll} 天 → 留 ${days} 天、${out.length} 行 → ${outFile}`);
