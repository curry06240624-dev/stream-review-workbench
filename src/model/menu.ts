/**
 * 按鈕文字（LINE 圖文選單／快速回覆／postback 送進來的字）—— 官方後台匯出不一定標成選單，所以用字面判斷。
 * 只留這一份：funnel／grade／import／schema 回填都從這裡產生；
 * Python 轉檔器 scripts/adapters/line_oa_csv_to_bundles.py 的 KNOWN_BUTTONS 是鏡像（Python 讀不到 TS，改這裡也要改那裡）。
 * 2026-09-08 從 2 萬段真對話按出現頻率抓的（❤️國產車 3,049、線上車庫🚗 19,038、X庫存N台、X就是你了）；新按鈕出現要加這裡。
 */
export const MENU_BUTTONS = [
  "回選單", "一年加油金", "瑋瑋中古車品牌理念", "我要諮詢哪裡瑕疵", "貸款", "售後保固", "想了解月繳款", "線上車庫", "線上估車", "本週新進車款", "出清專區",
  "國產車", "進口車", "露營車", "圓夢計畫", "我要抽加油金", "我要參加0元起標", "TIKTOK影片 加入", "代操案例", "資金需求", "我要花蓮救災資訊", "1", "2", "3", "4",
] as const;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SYM = "[^\\u4e00-\\u9fffA-Za-z0-9]*";   // 前後可以帶 emoji／符號（❤️國產車、線上車庫🚗）
/** 字面像按鈕：清單裡的字（前後可帶 emoji）、「X庫存N台」（車款選單）、「X就是你了」（選業務） */
export const MENU_LIKE = new RegExp(`^(?:${SYM}(?:${MENU_BUTTONS.map(escRe).join("|")})${SYM}|.{1,14}庫存\\d+台|\\S{1,6}就是你了)$`);
export const isMenuText = (t: string): boolean => MENU_LIKE.test(t.trim());
/** SQL 回填用（SQLite 沒有 regex）：字面完全相等的變體＋兩個 LIKE 樣式；跟 MENU_LIKE 盡量一致 */
const VARIANTS = [...MENU_BUTTONS, "❤️國產車", "❤️進口車", "🚎露營車", "🚕本週新進車款", "🚨出清專區", "🚘國產車", "線上車庫🚗", "線上估車🚗", "圓夢計畫💌"];
export const MENU_SQL_WHERE = `(TRIM(text) IN (${VARIANTS.map((b) => `'${b.replace(/'/g, "''")}'`).join(",")}) OR text LIKE '%庫存_台' OR text LIKE '%庫存__台' OR text LIKE '%就是你了')`;
