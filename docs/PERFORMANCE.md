# 效能與快取（2026-09-07，資料量到 5.4 萬個 lead／540 萬則訊息之後）

## 症狀
補灌 2024 年起的舊對話後，正式站 決策中心冷啟動 77 秒、分析頁 19 秒；而且記憶體快取在 DO 閒置被回收或重新部署後就沒了，一開總覽就卡一分鐘。

## 修法
1. **員工報表 O(n²)**（`src/engine/staff.ts`）：`leads.find(...)` 在角色列（幾萬筆）裡逐筆做，5 萬個 lead 時是 77 秒的主因 → `leadById` Map。
2. **對話表存最後訊息時間**（`conversations.last_staff_at／last_customer_at`，`src/model/schema.ts`）：匯入時算好（`src/adapters/import.ts`）；舊資料由 migrate 一次補齊，做完在 `settings` 留 `backfill_conv_last_at` 記號。員工報表的停滯數、決策卡「急迫客戶沒人回」、需要注意、配對的 last_at 都改用它，不再 GROUP BY 全部訊息。
3. **分析頁員工列／車款列**（`src/engine/analytics.ts`）：以前每人 8 個相關子查詢、每台車 6 個，未署名客服有 4 萬個 lead → 改成 3 句 GROUP BY 在 JS 對回去。本機 2 萬個 lead：10.5 秒 → 0.9 秒；結果逐欄比對完全一樣。
4. **持久快取**（`src/db.js cached()`）：記憶體 → SQLite `cache_json` → 重算。資料一改（匯入／漏斗／分析／分級／配對／行動）就 `bust()` 清兩層。快取桶按台灣日期換（`bucket()`），TTL 24 小時。
5. **暖快取**：每天台灣 00:10 的 cron（`wrangler.toml [triggers]` → `scheduled()`）把 7／14／30 天的 分析／員工效能／決策中心 先算好；`POST /api/admin/warm` 手動；`scripts/run_pipeline.mjs` 跑完也暖三個期間。`?fresh=1` 跳過快取強制重算（量冷啟動用）。

## 修完的數字（正式站，5.4 萬個 lead）
| 頁面 | 冷（重算） | 命中快取 |
|---|---|---|
| 分析（總覽／成交／漏斗／需要注意） | 2～4 秒 | 0.2 秒 |
| 員工效能 | 5 秒 | 0.2 秒 |
| 決策中心（含員工報表） | 5 秒 | 0.2 秒 |

## 注意
- Workers 的 `Date.now()` 沒有 I/O 時不會前進，所以回傳裡的 `timings` 在正式站全是 0，只有本機 wrangler dev 看得到分段時間。
- 對話列表／客戶搜尋是分頁查詢，沒有走快取，量不受影響。
- 再放大（例如 20 萬個 lead）第一個會碰到的是員工報表把全部 lead／事件／行為載進 JS（現在冷 5 秒）；到時改成只載期間內的 lead。
