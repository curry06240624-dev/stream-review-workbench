/**
 * AppDB —— 整個系統唯一的資料庫（Durable Object + SQLite）。
 *
 * 這份 schema 就是「底座」：第一天就照正式規格開，
 * 第二階段的四個驗收項（修改確認／保存每場／跨場重複問題／改善追蹤）
 * 全部已經有位子 —— 到時只開 UI，不動庫。
 *
 * 搬家路線：DO SQLite 與 D1 同為 SQLite 方言。正式上線搬到公司帳號時，
 * 把 SCHEMA 原封餵給 `wrangler d1 execute`，把本檔的 exec 換成 D1 prepare 即可。
 */
import { DurableObject } from "cloudflare:workers";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'operator',   -- admin | operator（訊息手等主系統角色之後加）
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  iter       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS failed_logins (
  email TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  until TEXT
);
/* ══ 訊息中心（Super 8 的核心）══════════════════════════════════
   權限模型照瑋瑋電話裡描述的：運營指派對話給訊息手，被指派者獨占，
   同層級互不可見，管理職全見。role: admin | operator | agent

   ⚠️ 身分鍵的設計是這套系統勝過 Super 8 的地方：
   LINE 的 userId 是綁「單一官方帳號」的（官方 FAQ 查證過），換帳號就對不回來。
   所以 contacts 的主軸是 phone（自有身分鍵），channel_uid 只是某個渠道的別名。
   一個人可以有多個 channel_uid（LINE 換號、FB、IG），但 phone 只有一組。 */
CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name  TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',      -- 自有身分鍵，跨渠道跨帳號都對得回來
  grade         TEXT NOT NULL DEFAULT 'C',     -- S | A | B | C（C＝未持續互動）
  note          TEXT NOT NULL DEFAULT '',
  blocked       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id),
  channel     TEXT NOT NULL,                   -- line | fb | ig
  channel_uid TEXT NOT NULL,                   -- 該渠道的 ID，換官方帳號就會變
  source      TEXT NOT NULL DEFAULT '',        -- 獲客渠道：meta | ig | line_search…
  UNIQUE(channel, channel_uid)
);
CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id),
  channel         TEXT NOT NULL DEFAULT 'line',
  assigned_to     INTEGER REFERENCES users(id),  -- NULL＝未指派，在運營的收件匣
  status          TEXT NOT NULL DEFAULT 'open',  -- open | closed
  last_message_at TEXT NOT NULL,
  unread          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  direction       TEXT NOT NULL,                 -- in（客戶）| out（我們）
  sender_user_id  INTEGER REFERENCES users(id),  -- out 才有
  text            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
/* 指派紀錄：誰把誰的對話轉給誰。瑋瑋要的可稽核性，Super 8 沒有給他這個。 */
CREATE TABLE IF NOT EXISTS assignment_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  from_user_id    INTEGER,
  to_user_id      INTEGER,
  by_user_id      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_assigned ON conversations(assigned_to, last_message_at);
CREATE INDEX IF NOT EXISTS idx_msg_conv      ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_cc_contact    ON contact_channels(contact_id);

CREATE TABLE IF NOT EXISTS streamers (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT '',
  active   INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS livestreams (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id  INTEGER NOT NULL REFERENCES streamers(id),
  live_date    TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  transcript   TEXT NOT NULL,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  livestream_id INTEGER NOT NULL REFERENCES livestreams(id),
  model         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'done',    -- done | failed
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id     INTEGER NOT NULL REFERENCES reviews(id),
  kind          TEXT NOT NULL,                   -- problem | action
  seq           INTEGER NOT NULL,
  ai_text       TEXT NOT NULL,
  quote         TEXT NOT NULL DEFAULT '',
  quote_pos     TEXT NOT NULL DEFAULT '',
  quote_ok      INTEGER NOT NULL DEFAULT 0,      -- 伺服器逐字核對過出處才是 1
  severity      TEXT NOT NULL DEFAULT '',        -- 重大 | 中 | 輕微（problem 才有）
  success_criteria TEXT NOT NULL DEFAULT '',
  -- ▼ 第二階段才開 UI 的欄位（運營修改確認），位子現在就擺好
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | edited | rejected
  final_text    TEXT NOT NULL DEFAULT '',
  operator_note TEXT NOT NULL DEFAULT '',
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ls_streamer ON livestreams(streamer_id, live_date);
CREATE INDEX IF NOT EXISTS idx_ri_review  ON review_items(review_id, kind, seq);
`;

export class AppDB extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  /** 全部列。參數用 ? 佔位。 */
  all(query, ...params) {
    return this.sql.exec(query, ...params).toArray();
  }

  /** 第一列或 null。 */
  first(query, ...params) {
    const rows = this.sql.exec(query, ...params).toArray();
    return rows.length ? rows[0] : null;
  }

  /** 寫入；回 { rowsWritten, lastRowId }。 */
  run(query, ...params) {
    const cur = this.sql.exec(query, ...params);
    cur.toArray();                     // 讓語句真的執行完
    const row = this.sql.exec("SELECT last_insert_rowid() AS id").toArray()[0];
    return { lastRowId: row ? row.id : null };
  }
}
