/**
 * AppDB —— 整個系統唯一的資料庫（Durable Object + SQLite）。
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
  role       TEXT NOT NULL DEFAULT 'agent',     -- admin | operator | agent
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

/* ══ 訊息中心 ═══════════════════════════════════════════════════
   權限模型照瑋瑋電話裡描述的：運營指派對話給訊息手，被指派者獨占，
   同層級互不可見，管理職全見。

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
/* 可設定的營運參數。SLA 目標放這裡而不是寫死在程式裡 ——
   「多久要回」是老闆的生意決定，不是工程師的常數。 */
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('sla_minutes', '30');

CREATE INDEX IF NOT EXISTS idx_conv_assigned ON conversations(assigned_to, last_message_at);
CREATE INDEX IF NOT EXISTS idx_msg_conv      ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_cc_contact    ON contact_channels(contact_id);
`;

/* 舊的直播覆盤模組已移除（見 git 歷史 commit 8402e70）。
   本機開發資料庫可能還留著那幾張表，留著無害，不會被任何查詢碰到。 */

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

  /** 寫入；回 { lastRowId }。 */
  run(query, ...params) {
    const cur = this.sql.exec(query, ...params);
    cur.toArray();                     // 讓語句真的執行完
    const row = this.sql.exec("SELECT last_insert_rowid() AS id").toArray()[0];
    return { lastRowId: row ? row.id : null };
  }
}
