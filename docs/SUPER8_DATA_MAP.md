# Super 8 欄位對照

格式：真實欄位 → 商業意義 → 在哪裡 → 例子 → 內部欄位 → 分析用途

| 真實欄位 | 商業意義 | 位置 | 例子 | 內部欄位 | 分析用途 |
|---|---|---|---|---|---|
| 顧客顯示名稱 | LINE 暱稱＋公司手動標記 | 列表、對話標題 | `B@8/29Cowboy(直人組裝)` | `contacts.display_name`（真資料存假名）；解析出 `first_contact_at` 候選、`-已購車`→SOLD POSSIBLE | 進線日期、成交訊號 |
| LINE userId | 該 OA 下的客戶識別 | URL `/customer/U…` | `U30ffc4…` | `contact_channels.channel_uid` | 去重、換 OA 會失效（要 external_key） |
| conversationId | 對話識別 | URL `/conversation/…` | `cf886f0d…` | `conversations.external_id` | 重匯不重複 |
| 收件匣 | 未指派/已指派/完成/機器人/垃圾/無效 | 篩選器 | 未指派 39,179 | `conversations.status` + `assigned_to` | 分流健康度 |
| 指派對象 | 誰負責 | 對話標題「妍宣黎 指派」 | 妍宣黎 | `conversations.assigned_to`、`leads.staff_id` | 歸因、跟進品質 |
| 訊息 | 文字/圖片/貼圖，發送者 | 對話 | 「你的預算大概是多少」 | `messages.text/msg_type/sender_role` | 全部規則的輸入 |
| 客服人員標籤 | 業務名縮寫 | 訊息旁「客服人員 LL」 | LL | `messages.sender_user_id` | 歸因 |
| 「正在輸入」「其他專員正在回覆中」 | 即時狀態 | 對話 | — | 不存 | 無 |
| 顧客標籤 | 公司自訂分類 | 篩選器（包含/不包含） | 未知清單 | 尚未建表；可進 `contacts.note` 或新表 | 分群 |
| 記事本 | 業務手寫備註（上限 30） | 右側面板 | 「會貸款~我有準備現金80萬…」 | `contacts.note`（去識別化後） | 貸款/預算訊號 |
| 智能摘要 | Super 8 的 AI 摘要 | 右側面板 | — | 不存（我們自己產） | — |
| 狀態 | 有效會員/已封鎖 | 客戶資訊 | 有效會員 | `contacts.blocked` | 封鎖率 34% |
| 加入時間／最近對話時間 | 時間戳 | 客戶資訊 | 19 天前／幾秒前 | `first_contact_at`／`last_message_at` | 週期長度 |
| 案件統計（已指派/結案/未完成） | Super 8 的案件定義 | 客服數據 | 281/26/255 | 不直接存；用我們的事件重算 | 對照用 |
| 平均客戶等待／處理時數 | Super 8 的服務指標 | 客服數據 | 2h43m／32h14m | 我們自算 FRT | 對照用 |
| 群組對話 | 客戶＋業務＋OA 三方群 | 訊息中心第二分頁 | 「瑋瑋中古車, 小飛, 志豪」 | v0.1 不匯入 | 之後 |
| 成交／毛利／分級 B、B+、A | **不在 Super 8** | 瑋瑋的試算表 | 待收 | `deals`、`contacts.grade` | 漏斗底部、毛利 |
