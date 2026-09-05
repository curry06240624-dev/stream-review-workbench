# 前端（v0.1）—— 六頁 SPA 怎麼組、怎麼驗

實作目標是 `docs/design/screens/01–06`（Curry 2026-09-04 核准）＋ `docs/IA.md`。
沒有框架、沒有打包：原生 ES modules，Cloudflare `[assets]` 直接服務 `public/`，Worker 對非 `/api/` 的 HTML 請求回 `/`（SPA fallback）。

## 檔案

| 檔案 | 責任 |
|---|---|
| `public/index.html` | 殼：側邊欄（8 個模組＋資料與設定）、指令列、`<main id="view">`；載 `cc.css`、Chart.js（cdnjs）、`app/router.js` |
| `public/cc.css` | 設計系統：色票（bg/layer/surface/line/text/muted、青＝互動、琥珀＝警示、紅＝緊急）、元件（`.panel .card .chip .kpi .funnel .tbl .stats .conv .thread .tl .ask .ans`） |
| `public/app/router.js` | 路徑路由（`/overview /funnel /attention /conversations[/:id] /insights/:id /appointments /deals /ask /data`）、`data-link` 攔截、指令列（`/api/search`，Ctrl/⌘+K，找不到就丟去 `/ask?q=`）、示範身分切換 |
| `public/app/api.js` | `api(path, body, method)`；`ensureLogin()`（沒帳號→/setup.html；DEMO_MODE→老闆一鍵登入） |
| `public/app/ui.js` | 所有頁共用的格式化（`pct nt wan num fmtDT ago delta`）、標籤表（`CONF CLAIM SEV STAGE EVENT LOST_REASON BODY_TYPE`）、元件（`insightCard kpi funnelStrip table bubble eventMark periodSeg drawChart`） |
| `public/app/pages/*.js` | 每頁一個模組，`export async function render(el, ctx)`，`ctx = { params, query, me, nav }` |

頁面對應的讀取 API 全在 `src/routes/views.ts`（`/api/search /api/leads[/:id] /api/attention /api/appointments /api/deals/list /api/series`），
分析數字來自 `GET /api/analytics`，洞察來自 `GET /api/insights` 與 `/api/insights/:id/evidence`，問 AI 走 `POST /api/ask`（`src/engine/ask.ts`）。

## 展示主線（10/26 要走的那條）

CEO 總覽（AI 簡報＋洞察卡）→ 點「查看證據」`/insights/:id`（事實／假設分開、建議動作可核准）→ 每位受影響客戶的證據訊息 →
「開啟完整對話」`/conversations/:id#m<msgId>`（訊息流內嵌事件標記、證據高亮；右欄 事實摘要／假設／建議下一步／出現在哪些洞察）。
問 AI：任何頁的指令列打自然語言 → `/ask`，答案固定七段：結論 → 關鍵數據（每顆可點回頁面）→ 原因／假設（事實、假設分標）→
受影響客戶 → 證據（洞察）→ 建議行動 → 我怎麼算的。圖表只在趨勢／分項比較有用時出現。

## 顏色紀律（核准時的全域修正）

- 紅只給「緊急」洞察；琥珀＝警示／偏離（逾期、爽約、低於成本、流失率高於全公司 10 點以上且樣本 ≥3）；青＝互動與系統狀態；正向指標維持中性，不用亮綠。
- 小樣本不上色：分項流失率要 `priced ≥ 3` 才可能標琥珀；100%（n=1）只是事實不是洞察。
- 客戶一律化名（`客戶#033`）＋公司習慣的顯示名（`7/26大哥`），展示可直接投影。

## 本機驗證

1. `npx wrangler dev --port 8788 < /dev/null &`（Browser pane 的 preview_start 養不活 wrangler，起好後用 `command-center-attach` 附上去）。
2. 灌資料：`node scripts/import_bundle.mjs data/mock/bundle.json http://localhost:8788 --reset` → `POST /api/admin/funnel/run` → `POST /api/insights/run`。
3. 語法：每個頁面模組複製成 `.mjs` 跑 `node --check`（三層巢狀樣板字串會在瀏覽器炸、其他工具看不出來）；Worker 端以 `npx wrangler deploy --dry-run` 為準。
4. 瀏覽器：每頁開一次看 console 只有 0 個 error；走一遍展示主線；`/ask` 六個範例題全部 `mode=ai`。

## 已知限制

- 業務／車款總表是累計數字（不分期間），頁面上有標「累計」。
- `/api/leads?event=` 不分期間（漏斗階段點進去是「曾到過這一階」的客戶）。
- 手機版只做到不破版（側邊欄隱藏、格線收成一欄），展示以桌機為準。

## 2026-09-05 新增四頁（員工效能、員工檔案、決策中心、流失原因）

| 路徑 | 模組 | 讀哪些 API | 內容 |
|---|---|---|---|
| `/staff` | `pages/staff.js` | `/api/staff`、`/api/staff/:id`（需關注第一位） | AI 團隊簡報（規則版）、表現最佳、需要關注、9 維度排名（Wilson 排序、資料不足不排）、成功 vs 需關注行為對照（前端池化、每格 n、任一邊 n<5 標「樣本不足」）、訊息品質分析、教練建議、成功模式庫、流失原因 × 員工熱圖、團隊與財務貢獻、團隊效能與協作組合、員工比較表 |
| `/staff/:id` | `pages/staffProfile.js` | `/api/staff/:id`、`POST /api/coaching/:id` | 活動／漏斗／營收毛利／協作四格、行為對照（本人 vs 表現最佳組 vs 團隊）、本期客戶（含流失原因）、教練計畫（改什麼・為什麼・證據・模式・把握）、訊息改寫範例（不代發）、流失原因對照團隊、示範的模式；「重新產生」走 AI 潤稿 |
| `/decisions` | `pages/decisions.js` | `/api/decisions`、`/api/mgmt-actions`、`/api/analytics` | 最重要的問題四格（人／客戶／漏斗／獲利）、需要決定的卡（為什麼重要・觀察到的差異・建議行動・預期衡量・按鈕）、管理行動中心（前 → 後、完成／取消）、先前行動的結果、推薦的管理動作 |
| `/loss` | `pages/loss.js` | `/api/loss` | 未成交總數與流程面比例、原因清單（點原因篩選）、本期 vs 前期圖、分項（業務／車款／車型／階段／價格帶／組別）、每位客戶的主因／副因／替代可能／面向／信心／證據摘要、推定流失折疊 |

- `app/mgmt.js`：`createAction` / `updateAction`，從卡片或教練建議建立行動；伺服器存基準快照。
- CEO 總覽多了「最重要的問題」四格與「行動狀態」；對話頁右欄多了「流失原因」框（主因／副因／替代可能／信心／面向）與參與角色 chip，流失證據在訊息流裡高亮。
- 顏色紀律照舊：需關注、落後、緊急＝琥珀；互動＝青；不用紅（決策卡沒有「critical」等級）。
- 驗證：四頁各開一次 console 0 error；決策卡「建立教練行動」→ 行動中心出現一列（基準 44%）→ 總覽「行動狀態」同步；`/staff/:id` 重新產生教練計畫；對話頁流失框與證據高亮。

## 2026-09-05 晚：真實資料流（訊息組／業務、送貨囉配對、估算毛利、涵蓋程度）

| 路徑 | 模組 | 讀哪些 API | 內容 |
|---|---|---|---|
| `/reconcile` | `pages/reconcile.js` | `/api/reconcile[?status=]`、`POST /api/reconcile/:id/(confirm|reject|undo|rematch)`、`POST /api/reconcile/rematch-all`、`POST /api/admin/import-group`、`/api/staff-aliases` | 待確認配對：四格（待確認／無法配對／自動配對／沒有成本的成交）、每則送貨囉貼文的解析欄位＋缺欄＋原文、配對提案（車／客戶／業務下拉，附理由與把握）、確認／拒絕／撤銷／重新配對、貼上 LINE 匯出檔、其他群組沒對上的貼文 |

- 成交與毛利：新增車號、來源（庫存／同行）、貸款欄；毛利格「估算」chip 或「無成本」；統計列多「無成本 n 筆」連到待確認配對。
- 員工效能／員工檔案：名字旁有性質 chip（訊息組／業務／共用座位）；不適用的指標顯示「不適用」、共用座位顯示「共用帳號」；毛利標估算與無成本筆數。
- 對話與證據：標題與右欄有「涵蓋不完整」chip 與原因；右欄多「估車」框與「送貨囉貼文」框；角色 chip 多「訊息組」。
- 資料與設定：員工工作性質（下拉）、Super 8 座位共用（勾選）、各系統暱稱（加／刪）；管理者才可改。
- 驗證：`node scripts/test_posts.ts`（解析器 45 項）、`scripts/eval_reconcile.mjs`（配對門檻）、scratchpad 的 confirm_flow（確認→成交建立→撤銷還原）與 import_group_test（真實 9/4 貼文貼入）；各頁 console 0 error。
