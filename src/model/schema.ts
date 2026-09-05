/**
 * 資料庫遷移。既有的 db.js 用 CREATE TABLE IF NOT EXISTS 建了第一批表；
 * 這裡補新表，並用「先查欄位再 ALTER」的方式擴充舊表 —— 每次啟動都會跑，必須冪等。
 */

/** DO 的 SqlStorage 最小介面，避免在型別檔還沒產生前就卡住 */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const NEW_TABLES = `
CREATE TABLE IF NOT EXISTS teams (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS vehicles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  brand        TEXT NOT NULL,
  model        TEXT NOT NULL,
  year         INTEGER,
  body_type    TEXT NOT NULL DEFAULT '',
  list_price   INTEGER NOT NULL,
  cost         INTEGER NOT NULL DEFAULT 0,
  stock_status TEXT NOT NULL DEFAULT 'in_stock',
  external_id  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  staff_id   INTEGER REFERENCES users(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  source     TEXT NOT NULL DEFAULT 'unknown',
  stage      TEXT NOT NULL DEFAULT 'new',
  outcome    TEXT NOT NULL DEFAULT '',
  opened_at  TEXT NOT NULL,
  closed_at  TEXT
);

CREATE TABLE IF NOT EXISTS appointments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id             INTEGER NOT NULL REFERENCES leads(id),
  staff_id            INTEGER REFERENCES users(id),
  proposed_at         TEXT NOT NULL,
  scheduled_for       TEXT,
  status              TEXT NOT NULL DEFAULT 'proposed',
  status_at           TEXT NOT NULL,
  evidence_message_id INTEGER REFERENCES messages(id)
);

CREATE TABLE IF NOT EXISTS visits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id        INTEGER NOT NULL REFERENCES leads(id),
  appointment_id INTEGER REFERENCES appointments(id),
  staff_id       INTEGER REFERENCES users(id),
  visited_at     TEXT NOT NULL,
  outcome        TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT ''
);

/* 成交/流失帳本。欄位形狀對齊「試算表的一列」，因為真實來源就是瑋瑋的表。 */
CREATE TABLE IF NOT EXISTS deals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER REFERENCES leads(id),
  contact_id    INTEGER NOT NULL REFERENCES contacts(id),
  staff_id      INTEGER REFERENCES users(id),
  vehicle_id    INTEGER REFERENCES vehicles(id),
  status        TEXT NOT NULL,
  sale_price    INTEGER NOT NULL DEFAULT 0,
  cost          INTEGER NOT NULL DEFAULT 0,
  gross_profit  INTEGER NOT NULL DEFAULT 0,
  lost_reason   TEXT NOT NULL DEFAULT '',
  closed_at     TEXT NOT NULL,
  external_key  TEXT NOT NULL DEFAULT '',
  source_system TEXT NOT NULL DEFAULT 'mock'
);

CREATE TABLE IF NOT EXISTS funnel_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         INTEGER NOT NULL REFERENCES leads(id),
  conversation_id INTEGER REFERENCES conversations(id),
  contact_id      INTEGER NOT NULL REFERENCES contacts(id),
  staff_id        INTEGER REFERENCES users(id),
  vehicle_id      INTEGER REFERENCES vehicles(id),
  type            TEXT NOT NULL,
  at              TEXT NOT NULL,
  confidence      TEXT NOT NULL DEFAULT 'CONFIRMED',
  source          TEXT NOT NULL DEFAULT 'rule',
  detail          TEXT NOT NULL DEFAULT '{}',
  UNIQUE(lead_id, type, at, source)
);

CREATE TABLE IF NOT EXISTS insights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  claim       TEXT NOT NULL DEFAULT 'fact',
  severity    TEXT NOT NULL DEFAULT 'medium',
  confidence  TEXT NOT NULL DEFAULT 'POSSIBLE',
  metric      TEXT NOT NULL DEFAULT '{}',
  period_from TEXT,
  period_to   TEXT,
  created_at  TEXT NOT NULL,
  dismissed   INTEGER NOT NULL DEFAULT 0
);

/* 證據＝指向訊息的指標＋為什麼。沒有證據的洞察不准上畫面。 */
CREATE TABLE IF NOT EXISTS evidence (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER REFERENCES funnel_events(id),
  insight_id INTEGER REFERENCES insights(id),
  message_id INTEGER REFERENCES messages(id),
  lead_id    INTEGER REFERENCES leads(id),
  note       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  insight_id  INTEGER REFERENCES insights(id),
  text        TEXT NOT NULL,
  owner_role  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'proposed',
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  decided_by  INTEGER REFERENCES users(id),
  result_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS briefs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_date TEXT NOT NULL UNIQUE,
  content    TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_system TEXT NOT NULL,
  entity        TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  external_id   TEXT NOT NULL DEFAULT '',
  captured_at   TEXT NOT NULL,
  raw_hash      TEXT NOT NULL DEFAULT '',
  UNIQUE(source_system, entity, external_id)
);

/* 歸因：一位員工在一個 lead 上的角色。primary/supporting/manager/handoff_from/handoff_to/reactivation */
CREATE TABLE IF NOT EXISTS lead_roles (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id             INTEGER NOT NULL REFERENCES leads(id),
  user_id             INTEGER NOT NULL REFERENCES users(id),
  role                TEXT NOT NULL,
  confidence          TEXT NOT NULL DEFAULT 'CONFIRMED',
  at                  TEXT,
  evidence_message_id INTEGER REFERENCES messages(id),
  note                TEXT NOT NULL DEFAULT '',
  UNIQUE(lead_id, user_id, role)
);

/* 流失原因分析：每一位未成交（或推定流失）客戶一列。哪裡掉＋為什麼掉＋信心＋證據。 */
CREATE TABLE IF NOT EXISTS loss_analyses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id            INTEGER NOT NULL UNIQUE REFERENCES leads(id),
  status             TEXT NOT NULL,
  primary_reason     TEXT NOT NULL,
  secondary_reason   TEXT NOT NULL DEFAULT '',
  alt_reason         TEXT NOT NULL DEFAULT '',
  driver             TEXT NOT NULL DEFAULT '',
  confidence         TEXT NOT NULL,
  stage              TEXT NOT NULL,
  staff_id           INTEGER,
  vehicle_id         INTEGER,
  appointment_status TEXT NOT NULL DEFAULT '',
  visit_status       TEXT NOT NULL DEFAULT '',
  first_at           TEXT,
  last_customer_at   TEXT,
  last_staff_at      TEXT,
  closed_at          TEXT,
  summary            TEXT NOT NULL DEFAULT '',
  method             TEXT NOT NULL DEFAULT 'rule',
  computed_at        TEXT NOT NULL
);

/* 訊息層行為特徵：每個 lead 一列，features 是 JSON { key: { v, msg } } */
CREATE TABLE IF NOT EXISTS behaviors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL UNIQUE REFERENCES leads(id),
  staff_id    INTEGER,
  features    TEXT NOT NULL DEFAULT '{}',
  computed_at TEXT NOT NULL
);

/* 教練計畫：每位員工最新一份（JSON），舊的留著看前後 */
CREATE TABLE IF NOT EXISTS coaching_plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER NOT NULL REFERENCES users(id),
  period_from TEXT,
  period_to   TEXT,
  content     TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT 'template',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_contact    ON leads(contact_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_leads_stage      ON leads(stage, outcome);
CREATE INDEX IF NOT EXISTS idx_fe_lead          ON funnel_events(lead_id, at);
CREATE INDEX IF NOT EXISTS idx_fe_type_at       ON funnel_events(type, at);
CREATE INDEX IF NOT EXISTS idx_appt_lead        ON appointments(lead_id, status_at);
CREATE INDEX IF NOT EXISTS idx_deals_closed     ON deals(closed_at, status);
CREATE INDEX IF NOT EXISTS idx_evidence_ins     ON evidence(insight_id);
CREATE INDEX IF NOT EXISTS idx_evidence_evt     ON evidence(event_id);
CREATE INDEX IF NOT EXISTS idx_insights_created ON insights(created_at, dismissed);
CREATE INDEX IF NOT EXISTS idx_roles_user       ON lead_roles(user_id, role);
CREATE INDEX IF NOT EXISTS idx_loss_reason      ON loss_analyses(primary_reason, staff_id);
`;

/** 舊表要補的欄位：[表, 欄位, 定義]。ALTER 沒有 IF NOT EXISTS，所以先查 PRAGMA。 */
const ADD_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ["users",         "team_id",          "INTEGER"],
  ["contacts",      "pseudonym",        "TEXT NOT NULL DEFAULT ''"],
  ["contacts",      "external_key",     "TEXT NOT NULL DEFAULT ''"],
  ["contacts",      "first_contact_at", "TEXT"],
  ["contacts",      "source_system",    "TEXT NOT NULL DEFAULT 'mock'"],
  ["conversations", "lead_id",          "INTEGER"],
  ["conversations", "external_id",      "TEXT NOT NULL DEFAULT ''"],
  ["messages",      "sender_role",      "TEXT NOT NULL DEFAULT ''"],
  ["messages",      "msg_type",         "TEXT NOT NULL DEFAULT 'text'"],
  ["messages",      "external_id",      "TEXT NOT NULL DEFAULT ''"],
  ["evidence",      "loss_id",          "INTEGER"],
  /* 管理行動中心：actions 從「洞察的建議」長成「有負責人、期限、前後指標的行動」 */
  ["actions",       "kind",             "TEXT NOT NULL DEFAULT ''"],
  ["actions",       "title",            "TEXT NOT NULL DEFAULT ''"],
  ["actions",       "staff_id",         "INTEGER"],
  ["actions",       "priority",         "TEXT NOT NULL DEFAULT 'medium'"],
  ["actions",       "due_at",           "TEXT"],
  ["actions",       "metric_key",       "TEXT NOT NULL DEFAULT ''"],
  ["actions",       "baseline",         "TEXT NOT NULL DEFAULT '{}'"],
  ["actions",       "after",            "TEXT NOT NULL DEFAULT '{}'"],
  ["actions",       "why",              "TEXT NOT NULL DEFAULT ''"],
  ["actions",       "measure",          "TEXT NOT NULL DEFAULT ''"],
  ["actions",       "owner_user_id",    "INTEGER"],
];

export function migrate(sql: SqlLike): { added: string[] } {
  sql.exec(NEW_TABLES);
  const added: string[] = [];
  for (const [table, col, def] of ADD_COLUMNS) {
    const cols = sql.exec(`PRAGMA table_info(${table})`).toArray();
    if (!cols.some((c) => c["name"] === col)) {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      added.push(`${table}.${col}`);
    }
  }
  // 舊資料的 sender_role 補值：out 是員工，in 是客戶
  sql.exec(`UPDATE messages SET sender_role = CASE direction WHEN 'out' THEN 'staff' ELSE 'customer' END
             WHERE sender_role = ''`);
  return { added };
}
