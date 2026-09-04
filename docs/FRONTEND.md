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
