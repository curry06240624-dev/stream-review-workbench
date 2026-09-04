# 漏斗模型

## 原則
- **事件不是階段**。一個 lead 是一串有時間戳的事件；「階段」是從事件推算出來的、可重算的衍生值。
- **每個事件帶證據**：指到哪一則訊息、為什麼這則支持這個判定。沒有證據的事件不寫入。
- **每個事件帶信心**：CONFIRMED／STRONGLY_SUGGESTED／POSSIBLE／UNCLEAR。畫面永遠顯示信心，不只顯示結論。
- **來源分開**：`ledger`（成交表、預約表等結構化紀錄）、`rule`（對話文字的決定性規則）、`ai`（模型判讀）、`manual`。
  真實資料裡 Super 8 **沒有**預約/到店/成交的結構化紀錄，所以 `rule` 的文字偵測不是備援，是主力。

## 事件與偵測規則（v0.1，決定性規則；AI 之後只補「為什麼」與模糊案例）

| 事件 | 觸發 | 信心 |
|---|---|---|
| NEW_LEAD | 第一則客戶訊息 | CONFIRMED |
| VEHICLE_INTEREST | 任一則訊息命中車輛主檔的品牌/車型；或 lead 已綁車 | 文字命中 CONFIRMED，僅綁車 POSSIBLE |
| ACTIVE_DISCUSSION | 48 小時內客戶 ≥2 則且業務 ≥1 則（有來有往） | CONFIRMED |
| PRICE_MENTIONED | 業務訊息出現「NN 萬」「報價」「含過戶」 | CONFIRMED |
| PRICE_OBJECTION | 報價後客戶訊息有「太貴／超出預算／便宜／再少」且**沒有**出價數字 | CONFIRMED |
| NEGOTIATION | 報價後客戶**出數字**、或「成交／簽／下訂／訂金」；或業務「跟主管申請／爭取」 | 客戶出數字 CONFIRMED，其餘 STRONGLY_SUGGESTED |
| **PRICE_DROP_OFF** | 報價後：客戶完全沒回且 ≥72h → CONFIRMED；客戶先異議再沉默 ≥72h → STRONGLY_SUGGESTED；報價後首次回覆延遲 ≥3× 先前中位數 → POSSIBLE；沉默 <72h → UNCLEAR。**之後有預約/到店/成交就不算流失。** | 依上 |
| FINANCING_QUESTION | 客戶「貸款／利率／頭期／月付／自備／分期／信用」。detail.resolved＝24h 內業務回覆含利率/頭期/月付/試算/專員 | CONFIRMED |
| APPOINTMENT_PROPOSED | 業務「約…時間／方便嗎／有空嗎／來店／來看車／留車」或預約表 proposed | CONFIRMED |
| APPOINTMENT_BOOKED | 預約表 booked（ledger）；文字備援：客戶給時間＋業務確認「見／留好／等您」 | ledger CONFIRMED，文字 STRONGLY_SUGGESTED |
| APPOINTMENT_CHANGED / CANCELLED / NO_SHOW | 預約表；文字備援：「改／取消／臨時有事／忘記」 | 同上 |
| STORE_VISIT | 到店表；文字備援：預約後業務「今天…看的／謝謝您來」 | 同上 |
| FOLLOW_UP | 客戶沉默 ≥24h 後業務主動發訊 | CONFIRMED（detail.gap_hours） |
| HIGH_INTENT | 客戶早期出現「這週／今天／馬上／急／現車／就想決定／要交車／老客戶」 | STRONGLY_SUGGESTED |
| CUSTOMER_INACTIVE | 距最後一則客戶訊息 ≥7 天且未成交 | CONFIRMED（是事實） |
| RE_ENGAGED | 沉默 ≥7 天後客戶再度發訊 | CONFIRMED |
| SOLD / LOST | 成交表（ledger）；文字備援：業務「恭喜／過戶完成／交車」→SOLD、客戶「跟朋友買／買了別家／先不換／預算不夠」→LOST；**顯示名稱含「已購車」→SOLD POSSIBLE**（這是真資料的訊號） | ledger CONFIRMED，文字 STRONGLY_SUGGESTED |

## 階段（衍生）
`new → interest → discussion → price → appointment → visit → negotiation → closed(sold|lost)`
取「到達過的最遠正向階段」。流失/不活躍不是階段，是事件。

## 準確率怎麼量
模擬器輸出 `data/mock/truth.json`：每個 lead 的劇本與「應該被偵測到的事件」。
`scripts/eval_funnel.mjs` 算每種事件的 precision / recall。門檻：PRICE_DROP_OFF recall ≥ 0.9、precision ≥ 0.85，
其餘 ≥ 0.8。**規則沒過門檻就不准上畫面**，先修規則。

## 對真資料的已知落差
- 沒有預約/到店/成交表 → 全靠文字規則＋瑋瑋的成交表（10/12 前要到）。
- 「已購車」寫在顯示名稱裡是公司習慣，不是保證每個人都寫 → 只給 POSSIBLE。
- 群組對話（客戶＋業務＋官方帳號三方群）另有一批訊息，v0.1 先不分析。
