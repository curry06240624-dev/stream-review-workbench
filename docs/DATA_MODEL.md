# 資料模型

實作：`src/model/types.ts`（型別）、`src/model/schema.ts`（遷移，冪等）、`src/model/bundle.ts`（adapter 輸出契約）。

## 三個設計決定
1. **成交/毛利帳本（deals）跟對話分開存。** 真實世界裡它在瑋瑋的試算表，不在 Super 8；
   模擬資料刻意保留同樣的縫，adapter 才不會在真資料來的時候撞牆。用 `external_key`（電話或 LINE 名稱）對回去。
2. **客戶以我們自己的 id 為主，`external_key` 對外、`pseudonym` 對畫面。** 真資料進來時 `display_name` 直接存假名，
   原名不落地（D-003）。
3. **所有來源先變 NormalizedBundle 再進庫。** `source_records` 記每筆從哪個系統、哪個原始鍵來，重匯不重複、可稽核。

## 實體與關係
```
teams ─┬─ users(staff)
       │
contacts ──< contact_channels（渠道別名：line userId 等）
contacts ──< leads ──< conversations ──< messages
              │  ├──< appointments
              │  ├──< visits（可指回 appointment）
              │  ├──< funnel_events ──< evidence ──> messages
              │  └──< deals（帳本）
insights ──< evidence ；insights ──< actions ；briefs（每日一筆）
```

## 從顯示名稱解析（公司習慣）
真實顯示名稱像 `B@8/29Cowboy(直人組裝)`、`9/01小新-已購車`、`12/19正杰`：
- 開頭 `M/D`＝首次進線日期（adapter 解成 `first_contact_at` 的候選）
- 前綴 `B@`＝意義待瑋瑋確認（推測是分級 B 或某來源）
- 後綴 `-已購車`＝成交標記 → SOLD POSSIBLE
- 括號內＝備註（車款、身分）
adapter 保留這些片段當訊號，但**去掉人名**。

## 欄位單位
金額一律「元」整數；時間一律 ISO 8601 UTC，畫面轉台灣時間（Workers 跑 UTC，這裡踩過一次）。
