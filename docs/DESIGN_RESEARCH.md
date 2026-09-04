# 設計研究（做 UI 之前）

日期：2026-09-04。目的：不自己發明，先看成熟系統怎麼解「老闆 30 秒看懂現在要注意什麼」。

## 看了哪些類別
營收情報平台（Gong／Clari 一類）、指揮中心／控制室設計指南、例外導向的主管儀表板、
Bloomberg 終端機的資訊密度傳統、AI 儀表板設計模式、汽車經銷 CRM。

## 抽出來的原則（會直接進我們的畫面）

1. **第一屏只回答「現在什麼需要我」**。主管要的是「哪裡偏離、哪裡有風險、哪裡有機會」，每多一次點擊就少一次使用。
   → CEO 總覽最上面是 AI 簡報＋嚴重度排序的洞察，不是一排 KPI 卡。
2. **例外導向＋顏色紀律**：控制室的規矩是「紅＝立即威脅、琥珀＝偏離常態」，其餘一律中性；
   60% 的警示被忽略是因為過度飽和。→ 琥珀/紅只給嚴重度，青色留給系統/可互動，其他灰階。
3. **三次點擊內到證據**：指揮中心把「升級到事件」壓在三步以內。→ 洞察卡 → 證據頁（每個 lead 一組對話）→ 完整對話，最多三層。
4. **漸進揭露**：摘要 → 模式 → 明細三層，各層篩選行為一致，不要更深。
5. **可解釋 AI 疊層是必需品不是加分**：每條建議要看得到輸入、信心、資料來源；沒有不確定性表示＝假自信。
   → 每條洞察顯示 claim（事實/相關/假設）、confidence、n；AI 的「為什麼」明標「假設」。
6. **情報要往下流也要往上流**：Clari 類產品的批評是情報只流向 CRO、不告訴業務「我現在該做什麼」。
   → 動作卡註明 ceo / manager / staff，訊息手版只看自己的。
7. **密度是特色不是缺點**（Bloomberg）：深色底、表格數字對齊、少裝飾、固定版位；用「藏複雜度」而不是「刪功能」。
   → 表格用 tabular-nums、固定欄寬；不做大空白卡。
8. **對話式查詢的坑**：解讀不清、多輪沒有脈絡、品質不穩會毀掉信任。→ Ask AI 每個答案都附證據與「我怎麼算的」。
9. **動作模組要有護欄**：v0.1 不從畫面觸發任何對外動作（不發訊息），只記錄「核准／駁回／完成＋結果」。
10. **經銷 CRM 的教訓**：84% 的 lead 在 30 天後仍然沒被碰過 —— 「沒人跟進」本身就是最大的洞察類別。

## 9/4 補充研究（Step 2，針對規格點名的系統）

11. **Pipeline Inspection 模式**（Salesforce Einstein／Dynamics Sales Accelerator）：一個畫面同時放「指標＋健康訊號＋本週變化」，
    停滯的案子由 AI 產摘要＋建議下一步；業務端有「今天該做的高影響動作」的單一工作區。
    → 我們的「需要注意」頁就是這個：一個佇列、每列帶原因與建議、可結案。
12. **物件中心的鑽取**（Palantir Object Explorer／Workshop）：不是從圖表鑽到圖表，是從「物件」（客戶、車、業務）鑽到它的所有關聯與時間序，
    篩選到哪一層都保留。→ 我們的 lead 頁＝物件頁：事件時間軸＋對話＋出現在哪些洞察。
13. **自然語言查詢要交「成品」不是中間資料**（ThoughtSpot Spotter：多段問句 → 自動出圖 → 根因異常偵測 → 可鑽到底層）；
    Databricks Genie／Zenlytic 靠語意層定義才不會亂答；所有廠商都承認「仍需人工審核」。
    → 問 AI 的答案固定三件套：結論（事實/假設分開）＋引用數字（可點到來源頁）＋受影響 lead；並附「我怎麼算的」。
14. **AI 層是嵌入不是另開一頁**（HubSpot Breeze 嵌在每個模組裡）。→ 每頁頂端一句 AI，而不是把 AI 全塞在問 AI 頁。

## 三個概念方向（給 Higgsfield 出圖用）
- **A 主管指揮中心**：簡報＋嚴重度排序＋漏斗＋證據側欄，偏電影感但克制
- **B 戰術營運**：密度高、佇列導向（待處理對話、預約、到店、成交流），偏任務控制
- **C 極簡 AI 情報**：一個 Ask AI、一段敘事、三張問題卡、證據抽屜，Apple 式留白但深色

## 來源
- Revenue intelligence 比較：revenue.io、cirrusinsight（Clari vs Gong）、tellius、zoominfo
- 儀表板模式：aufaitux（AI 儀表板六種模式）、uxpin、setproduct、pencilandpaper
- 指揮中心：activu（控制室設計指南、SOC 儀表板檢查表）
- 主管儀表板：alphabyte（例外導向）
- 密度傳統：Bloomberg（conceal complexity）、SAS 社群「LLM Terminal」
- 經銷 CRM：tekion、vinsolutions、dealerfunnel、impel（84% 未碰 lead）
- 9/4 補充：sybill（Salesforce vs HubSpot vs Dynamics）、outreach、forecastio；palantir docs（Object Explorer／Workshop）；
  holistics、querio、zenlytic（ThoughtSpot Spotter／Databricks Genie）
