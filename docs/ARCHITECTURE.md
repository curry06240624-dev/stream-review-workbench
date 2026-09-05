# 架構

```
資料來源                    adapter                內部模型 (DO SQLite)          引擎                         畫面
──────────                 ────────               ─────────────────            ────────                     ────
模擬器 gen_mock.ts    ─┐                          contacts / leads /           funnel.ts   事件＋證據＋信心    CEO 總覽
Super 8 瀏覽器擷取     ├─→ NormalizedBundle ─→ import.ts ─→ conversations / messages   →  analytics.ts 決定性數字  →  漏斗／價格流失／預約／到店
瑋瑋的成交/毛利表     ─┤   (bundle.ts)                       vehicles / appointments /     insights.ts 規則推導        洞察＋證據
之後的 API / CSV      ─┘                          visits / deals               ai.ts       敘事＋簡報（閘門）   CEO 簡報／Ask AI
                                                  funnel_events / evidence /
                                                  insights / actions / briefs
```

- **Cloudflare Worker + Durable Object SQLite**（免費、Curry 的帳號額度內；schema 與 D1 同方言，可搬公司帳號）
- 新程式全 TypeScript（`npm run typecheck` 兩份 tsconfig）；既有 JS 模組（auth/inbox/situation/autoreply）沿用
- 前端 ES modules ＋ Chart.js，沿用 JARVIS 視覺系統（`public/app.css`）
- 權限：`admin`／`operator` 看全公司；`agent` 只看自己（SQL 層擋、404 不 403）

## API（新）
| 路由 | 用途 |
|---|---|
| POST /api/admin/import[?reset=1] | 匯入 NormalizedBundle（admin） |
| POST /api/admin/funnel/run | 重算事件（冪等；ai 事件保留） |
| GET  /api/admin/funnel/events | 事件＋階段分布（評測用） |
| GET  /api/analytics?days=7&to= | 決定性數字（管理職） |
| POST /api/insights/run | 分析→洞察→證據→AI 敘事→簡報 |
| GET  /api/insights | 洞察清單（含動作、證據數） |
| GET  /api/insights/:id/evidence | 每個 lead 一組：客戶/業務/車/階段＋證據訊息與前後脈絡 |
| GET  /api/brief?date= | CEO 簡報 |
| PATCH /api/actions/:id | approved / dismissed / done ＋ result_note（閉環） |
| PATCH /api/insights/:id | dismissed |

## 冪等與重算
- 匯入以 `source_records(source_system, entity, external_id)` 去重
- 漏斗重算先刪同 lead 的 rule/ledger 事件再寫；UNIQUE(lead_id, type, at, source)
- 洞察同期間重算先刪未駁回的舊洞察；被駁回的保留、同名不重建

## 排程（待做）
每日台灣 06:00：funnel/run → insights/run（含簡報）。簡報預先產好，開頁不等 AI。

## 正式環境兩個坑（2026-09-04 部署實測）

1. **Worker→DO 每次查詢都是一次 subrequest**，免費方案一次呼叫上限 1000。匯入 1,344 則訊息、或跑 144 個 lead 的漏斗，
   在 Worker 端直接爆「Too many API requests by single Worker invocation」。解法：重活搬進 DO 本地跑
   （`db.js` 的 `importLocal / funnelLocal / insightsLocal`），Worker 只呼叫一次。
2. **從 DO 打 Gemini 會被拒** `400 User location is not supported for the API use.`（DO 被釘在某個機房），
   Worker 端從台灣打就正常。所以 AI 敘事（narrate / brief / ask）一律留在 Worker 端；`GET /api/admin/ai-probe`
   會同時回 Worker 與 DO 兩邊的結果，之後換機房或換模型先打這支。
3. 同一天重跑洞察會產生重複卡：`insightsLocal` 把同期間長度、同一天的舊洞察標成 `dismissed=2`（被取代），
   1 仍然代表使用者駁回。

## 2026-09-05 晚：貼文解析與配對層
`src/engine/posts.ts`（解析：送貨囉／估車／接待／LINE 匯出檔）→ `src/engine/reconcile.ts`（配對、確認、撤銷、群組貼文匯入）→ `deal_reports / appraisals / group_posts / staff_aliases` 四張新表（`src/model/schema.ts`）。
匯入 bundle 時若帶 `deal_reports`／`appraisals` 原文，會先跑一次漏斗再配對（到店／議價訊號幫忙挑客戶）。所有重活仍在 DO 內（`db.js` 的 `reconcileLocal / ingestGroupLocal / reportActionLocal / rematchAllLocal`）。
