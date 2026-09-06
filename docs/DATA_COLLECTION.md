# 資料怎麼收、怎麼接（照系統的資料結構）

更新 2026-09-05。目的：把「系統要什麼」翻成「跟誰要什麼、怎麼拿、拿到後怎麼進系統」。
資料結構本身見 `src/model/bundle.ts`（匯入格式）與 `src/model/types.ts`（資料表）；公司的實際流程見 `docs/DATA_FLOW.md`。

## 0. 一張圖

```
Super 8（MCP／API／匯出鈕）──┐
LINE 官方後台匯出 ───────────┼─→ adapter（去識別化）→ bundle.json → validate → POST /api/admin/import → 漏斗 → 分析
內部群匯出 .txt（成交／接待／估車）┘                                   └─→ /reconcile 貼上 → 配對 → 成交
車源表（Google Sheets API）────────────────────────────────→ vehicles
會計月成本表（CSV）────────────────────────────────────────→ deals.cost（cost_source='accounting'）
員工名冊（口述）───────────────────────────────────────────→ users.job / seat_shared / staff_aliases
```

三條紅線：**只讀不寫**（Super 8 用 customer-readonly 或只讀 token）、**不動 LINE webhook**（一個 OA 只能一個，切了 Super 8 就斷）、**去識別化在進系統前做**。

## 1. 系統要的每一塊資料，從哪裡來

| bundle 區塊 | 系統表 | 真實來源 | 關鍵欄位 | 誰能給 |
|---|---|---|---|---|
| `staff` | users, staff_aliases | 員工名冊（口述） | 姓名、組別、工作性質（訊息組／業務／兩者）、Super 8 座位是否共用、各系統暱稱 | 瑋瑋、黎 |
| `vehicles` | vehicles | 車源表（Google Sheet） | 車牌、年份、廠牌、車型、顏色、里程、開價、成本、目前狀況、入庫時間 | 綠化（分享）、瑋瑋（核准） |
| `customers` | contacts | Super 8 客戶（LINE userId、顯示名稱、加入時間、封鎖狀態） | userId→external_key、顯示名稱→化名、加入時間 | 瑋瑋（Super 8） |
| `conversations` + `messages` | conversations, messages | Super 8 對話 ＋ LINE 官方後台匯出（補 Super 8 看不到的回覆） | 訊息文字、時間、誰發的（客戶／客服縮寫）、類型（圖片只存佔位）、via | 瑋瑋、黎 |
| `leads` | leads | 沒有；一個 Super 8 對話＝一段旅程，adapter 一對一建 | 開啟時間＝第一則客戶訊息；結果先空著，由成交群配對補 | adapter 自動 |
| `assignments` | assignment_log | Super 8 對話標題「XXX 指派」 | 指派給誰、時間 | Super 8 |
| `appointments` | appointments | 沒有結構化來源；對話文字規則判（已驗證） | — | 不用要 |
| `visits` | visits | **接待群貼文**（客戶名／車款／到店時間／誰指派） | 到店＝權威來源；「誰指派」＝業務 | 黎（匯出） |
| `deal_reports` | deal_reports → deals | **成交群「送貨囉」貼文** | 車號、售價、同行/庫存、訂金、貸款結果、發文人 | 黎（匯出） |
| `appraisals` | appraisals | **估車群貼文** | 車型、年份、里程、權威、天書、車換車or純賣 | 黎（匯出） |
| `deals.cost` | deals | 會計月成本表 | 車號、成交日、售價、成本 | 瑋瑋（會計） |

## 2. 每個來源怎麼拿

### 2.1 Super 8（客戶與對話的主來源）

已知（8/26 實地探索 `docs/SUPER8_DISCOVERY.md`、9/5 綠化說法）：
- 有 **MCP**（37 個工具，瑋瑋方案免費額度 5,000 點／兩週）與 **API**（付費，8/26 查約 5 萬；文件沒公開）。LINE 的 webhook 已被 Super 8 用掉。
- 每一頁有「匯出目前數據」按鈕，還沒人按過，不知道匯出什麼欄位。
- 畫面上看得到的欄位對照在 `docs/SUPER8_DATA_MAP.md`：顯示名稱（含 M/D 日期前綴與「-已購車」）、URL 裡的 userId 與 conversationId、對話標題「XXX 指派」、訊息旁「客服人員 LL」縮寫、記事本、標籤、封鎖狀態、加入時間。

要跟瑋瑋要的（照順序，先免費的）：
1. **MCP 連線資訊**：端點、只讀 token、工具清單文件。先用他的免費額度抓 30 位客戶的完整對話當 Track B 切片。
2. **「匯出目前數據」按一次**：客戶列表頁與對話頁各按一次，把檔案（去識別化前也可以，我在本機處理）給我，看欄位有沒有訊息全文。
3. **API 文件與報價**：如果 MCP 額度不夠日常同步，再決定要不要付費 API。這是瑋瑋的錢，由他決定。
4. 一個 **只讀帳號或只讀 token**，不要用別人的登入。

拿到後 adapter 怎麼對：
- 對話 → `conversations`（`key`＝conversationId）；訊息 → `messages`（`role`：客戶／staff／bot；`staff_name`＝客服縮寫，縮寫要進 `staff.aliases`；圖片貼圖只存「[圖片]」）；`via='super8'`。
- 客戶 → `customers`（`key`＝userId、`external_key`＝userId、`display_name`＝去識別化後的化名；日期前綴解析成 `first_contact_at`；「-已購車」字樣保留在顯示名稱裡，規則會用）。
- 「XXX 指派」→ `assignments`＋`conversations.assigned_staff`。
- 記事本 → 去識別化後放 `customers` 的備註（之後）；標籤 → 之後。
- 每個對話建一個 `lead`（`opened_at`＝第一則客戶訊息、`outcome=''`）。

### 2.2 LINE 官方帳號後台（補 Super 8 看不到的回覆）

- 綠化：「Line官方有提供歷史紀錄下載」，但 Super 8 回的不在裡面；反過來訊息組在官方後台打的字 Super 8 看不到。兩邊合起來才完整。
- 要問黎：誰有後台權限、匯出是什麼格式、先給一份**去識別化的樣本**（三位客戶）。
- adapter：兩邊訊息用「同一個 userId ＋ 同一分鐘 ＋ 同文字」視為同一則去重；官方後台來的標 `via='line_oa'`。電話不會有紀錄，所以 `coverage` 交給匯入器的規則判（客戶提到「電話裡講的」就標不完整）。

### 2.3 內部群（成交群／接待群／估車群）

- 任何群成員的手機：聊天室右上 › 設定 › **匯出聊天紀錄** → .txt。
- 貼到畫面「待確認配對」底下的貼上框，或 `POST /api/admin/import-group {kind:"auto", text}`。同一則不會重複匯入。
- 要問黎：三個群**最近 60 天**各一份；之後每週一次。長期解＝群裡放機器人（入庫群已經有），但那是瑋瑋公司的決定。
- 貼文格式與缺欄見 `docs/DATA_FLOW.md` §3；順便請業務在送貨囉加「客戶：」「業務：」兩行、車號必填。

### 2.4 車源表（Google Sheet）

- 綠化：機器人用 **Google Sheets API v4 ＋ 服務帳號** 讀寫；申請權限要問公司，他沒權限給。
- 步驟：我在 Google Cloud 建一個服務帳號 → 把服務帳號的 email 給綠化／瑋瑋 → 他們把試算表以**檢視者**分享給那個 email → adapter 每天讀一次全表。試算表不會被寫入。
- 欄位對照（照 9/5 截圖，T 欄之後還沒看到，要補）：

| 車源表 | bundle `vehicles` | 備註 |
|---|---|---|
| 入庫時間 | `stock_in_at` | 庫齡用 |
| 年份 | `year` | |
| 車型／廠牌 | `model`／`brand` | |
| 車牌號碼 | `plate` | **送貨囉對回車源表唯一的鍵** |
| 顏色 | `color` | 配對用 |
| 目前狀況 | `status_text` → `stock_status` | 現在用列顏色標，請改成欄位值（在庫／已訂／已售／調車） |
| 里程 | `mileage_km` | |
| 認證狀況 | `cert` | |
| 版本 | `trim` | |
| 開價 | `list_price` | 折讓＝（開價－售價）／開價 |
| 調作價 | `sell_price` | 實賣價：談完真正賣給客戶的價格（Curry 2026-09-06 確認），在庫車也會先填。估算毛利＝調作價－成本，開價只是掛牌 |
| 成本 | `cost`（沒有→`null`） | 估算毛利＝售價－成本 |
| 待修備註／備註 | 不存或去識別化後存 | |
| 排氣量／資料／照片／鑰匙 | 不存 | |

- 同行調的車不在表裡：送貨囉寫「同行/庫存：誠鑫」的，系統不會用車型去猜庫存車、也不算成本。

### 2.5 會計月成本表

- 欄位：車號、成交日、售價、成本（、毛利、業務）。CSV 或 Excel。
- 匯入時用車號＋成交日（±3 天）對到 `deals`，`cost_source='accounting'`，畫面不再標「估算」。（匯入腳本待寫，格式拿到再定。）

### 2.6 員工名冊

- 每個人：姓名、組別、工作性質（訊息組／業務／兩者／主管）、Super 8 座位是否借用共用、LINE 群暱稱、Super 8 客服縮寫、車源表寫法。
- 進 `staff`（`job`、`seat_shared`、`aliases`），或直接在畫面「資料與設定」手動填。對不到的名字畫面會標「暱稱表要補」。

## 3. 去識別化（adapter 裡做，進系統前）

- 顯示名稱 → `客戶#NNN` 化名；對照表留在本機（或瑋瑋公司），不上雲。
- 電話：去掉，或只留 SHA-256 雜湊當 `external_key`；LINE userId 可以留（它只在這個 OA 有效）。
- 車牌：**保留**（配對要用），但只存在這個系統。
- 證件照片（行照、身分證）：不下載；訊息裡出現身分證字號、電話、地址用規則抹掉（匯入器會再抹一次，`scrubMessage`）。
- 資料放哪：現在是 Curry 的個人 Cloudflare 帳號，真資料進來前要開**公司自己的帳號**（瑋瑋）。

## 4. 每次匯入的順序

**最簡單的路：畫面「資料上傳」（`/uploads`）。** 公司把檔案丟進去就好：LINE 匯出 .txt 會自動變成群組貼文並配對；車源表 CSV 會更新車輛主檔；會計成本表 CSV 會把正式成本寫進成交（畫面不再標估算）；bundle.json 按「匯入」；PDF、截圖、Excel 先存著，標「待 Curry 處理」。上面的「收集進度」直接顯示還缺哪幾樣。檔案本體放 Workers KV（單檔 25 MB），中繼資料在 `documents` 表；重複的檔案會被擋。

命令列版：

```bash
node scripts/validate_bundle.mjs bundle.json                 # 結構、參照、個資掃描
node scripts/import_bundle.mjs bundle.json https://<站> [--reset]   # 第一次 --reset，之後不用（external_id 去重）
# 然後（登入後）
POST /api/admin/funnel/run  →  POST /api/admin/analyze  →  POST /api/insights/run
# 內部群匯出貼到 /reconcile → 確認配對 → 再跑一次上面三個
```

例子檔：`data/examples/bundle_example.json`（每種實體各一筆，可以直接匯入試）。

## 5. Track B 真切片（10/12 前）最少要這四樣

1. Super 8：30 位客戶的完整對話（MCP 抓或匯出鈕）。
2. 成交群、接待群、估車群最近 60 天的匯出檔。
3. 車源表唯讀分享。
4. 員工名冊（暱稱、工作性質、座位）。

有這四樣就能把「客戶 → 訊息組 → 到店 → 業務 → 成交 → 估算毛利」整條跑完；會計成本表與 LINE 官方後台匯出是之後補精度用的。

## 6. 可以直接貼的問法

**給瑋瑋（Super 8 與帳號）**
> 瑋瑋，接資料我需要三樣：①Super 8 的 MCP 連線資訊（端點、只讀 token、工具文件），我先用免費額度抓 30 位客戶的完整對話做測試；②請你在 Super 8 客戶列表和對話頁各按一次「匯出目前數據」，檔案給我看欄位；③公司自己開一個 Cloudflare 帳號，真資料不放我個人帳號。付費 API 要不要買，等免費額度試過再跟你報告。

**給綠化（車源表）**
> 綠化，車源表我想用你說的 Google Sheets API＋服務帳號的方式唯讀。我建好服務帳號後把 email 給你，麻煩請有權限的人把試算表用「檢視者」分享給那個 email 就好，不會寫入。另外想確認 T 欄之後還有哪些欄位、目前狀況能不能改成欄位值而不是列顏色。

**給黎（群組與後台）**
> 黎，想跟你要四份：成交群、接待群、估車群最近 60 天的聊天紀錄匯出（聊天室 › 設定 › 匯出聊天紀錄，.txt），還有 LINE 官方後台匯出的三位客戶樣本（名字遮掉）。客戶名和車牌我只用來對資料，不會外流。另外每位訊息組同事的 LINE 暱稱和 Super 8 縮寫麻煩給我一份。

## 車源表的狀態會直接變成成交／收訂中（2026-09-06）

「目前狀況」欄寫 `收訂(軒)`／`送貸(軒)`／`過件(安)` 就會出現在「成交與毛利 → 收訂中」，備註寫「售出」就算成交；售價用調作價（沒填用開價）。
所以請訊息組維持這個寫法：括號裡放業務暱稱、交車後把備註改成「售出」（或狀態寫 已售）。詳見 `DATA_FLOW.md`「車源表 → 成交／收訂中」。
