# 整合落差分析（模擬模型 vs 真實 Super 8）

更新：2026-09-04。真切片還沒進來，這是從實地探索推的第一版；真切片匯入後重寫。

## 內部欄位已支援、Super 8 也有
| 內部 | Super 8 來源 | 備註 |
|---|---|---|
| contacts.display_name / first_contact_at | 顯示名稱（含 M/D 前綴） | 解析日期前綴；真資料存假名 |
| contact_channels.channel_uid | URL 的 LINE userId | 換 OA 會變 |
| conversations.external_id | URL 的 conversationId | 重匯不重複 |
| conversations.assigned_to | 對話標題「XXX 指派」 | readonly 看得到名字 |
| messages.text / sender_role / msg_type / created_at | 對話畫面 | 圖片貼圖只存佔位字 |
| contacts.blocked | 客戶狀態 | |
| contacts.note | 記事本 | 去識別化後 |

## 內部有、Super 8 沒有（要靠文字規則或瑋瑋的表）
| 內部 | 真實來源 | 落差 |
|---|---|---|
| vehicles、leads.vehicle_id | 訊息文字裡的車款 | 要建車輛主檔才對得到；顯示名稱括號備註有時有車款 |
| appointments | 對話文字（「週六下午兩點」「見」） | 純文字規則已驗證可用（預約成立 1.00、爽約 1.00 on mock） |
| visits | 對話文字（「今天看的」） | 0.98 on mock |
| deals（成交/毛利） | **瑋瑋的試算表**＋顯示名稱「-已購車」 | **10/12 前要到**；對應鍵未知 |
| contacts.grade（B/B+/A） | 瑋瑋的分級表 | 同上 |
| leads（旅程） | 無；一個 Super 8 對話≈一個 lead | adapter 一對一建 |
| users.team_id | 無（角色只有 admin/private-only/customer-readonly） | 由瑋瑋口述建 |

## 命名不同
- Super 8「案件」≠ 我們的 lead：它的「已指派/未指派/完成」是收件匣狀態，不是旅程階段
- Super 8「智能摘要」是它的 AI；我們自己產，不匯入

## 我們誤解過的關係
- 原以為群組對話有內部員工脈絡 → 實查是三方交易群且多已退出，核心群 2025-11 退出。**v0.1 不做群組。**
- 原以為 Super 8 有預約/成交結構 → 沒有，全在文字與外部表

## 漏斗階段要改的
- 真資料的「流失」大多是沉默，沒有明說 → 畫面上要把「推定流失」跟「確定流失」分開顯示（已做）

## 額外可用的中繼資料
- 顧客標籤（篩選器可見，清單未知）→ 可當分群維度
- 記事本（上限 30 則）→ 貸款/預算訊號
- 「其他專員正在回覆中」→ 不存

## 整合限制
- 一個 OA 一組 webhook；即時流只有取代 Super 8 才拿得到（不在 v0.1）
- 對話匯出無文件；免費 MCP 待瑋瑋測；瀏覽器擷取一則約 5–20 秒，只適合幾十則的切片
- readonly 看不到 客戶中心/匯出/設定；擷取以 訊息中心 為限
