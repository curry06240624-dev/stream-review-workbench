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

/* 成交群「送貨囉」貼文：解析欄位＋配對狀態。確認後才生成 deals 列。 */
CREATE TABLE IF NOT EXISTS deal_reports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reported_at         TEXT NOT NULL,
  reported_by         TEXT NOT NULL DEFAULT '',
  reported_by_user_id INTEGER,
  year                INTEGER,
  model_text          TEXT NOT NULL DEFAULT '',
  color               TEXT NOT NULL DEFAULT '',
  plate               TEXT NOT NULL DEFAULT '',
  plate_norm          TEXT NOT NULL DEFAULT '',
  deposit             TEXT NOT NULL DEFAULT '',
  sale_price          INTEGER,
  source_kind         TEXT NOT NULL DEFAULT '',
  peer_dealer         TEXT NOT NULL DEFAULT '',
  delivery_by         TEXT NOT NULL DEFAULT '',
  delivery_uncertain  INTEGER NOT NULL DEFAULT 0,
  note                TEXT NOT NULL DEFAULT '',
  loan_status         TEXT NOT NULL DEFAULT '',
  customer_ref        TEXT NOT NULL DEFAULT '',
  staff_ref           TEXT NOT NULL DEFAULT '',
  raw_text            TEXT NOT NULL DEFAULT '',
  missing             TEXT NOT NULL DEFAULT '[]',
  match_status        TEXT NOT NULL DEFAULT 'unmatched',
  match_method        TEXT NOT NULL DEFAULT '',
  match_confidence    TEXT NOT NULL DEFAULT '',
  match_reasons       TEXT NOT NULL DEFAULT '[]',
  vehicle_id          INTEGER,
  lead_id             INTEGER,
  contact_id          INTEGER,
  staff_id            INTEGER,
  candidates          TEXT NOT NULL DEFAULT '{}',
  deal_id             INTEGER,
  deal_created        INTEGER NOT NULL DEFAULT 0,
  source_system       TEXT NOT NULL DEFAULT 'mock',
  external_id         TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  confirmed_by        INTEGER,
  confirmed_at        TEXT,
  UNIQUE(source_system, external_id)
);

/* 估車群貼文（只有文字欄位；行照照片永遠不入庫） */
CREATE TABLE IF NOT EXISTS appraisals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reported_at         TEXT NOT NULL,
  reported_by         TEXT NOT NULL DEFAULT '',
  reported_by_user_id INTEGER,
  model_text          TEXT NOT NULL DEFAULT '',
  year                INTEGER,
  trim                TEXT NOT NULL DEFAULT '',
  color               TEXT NOT NULL DEFAULT '',
  mileage_km          INTEGER,
  book_quanwei        INTEGER,
  book_tianshu        INTEGER,
  mode                TEXT NOT NULL DEFAULT '',
  customer_ask        INTEGER,
  customer_ref        TEXT NOT NULL DEFAULT '',
  lead_id             INTEGER,
  contact_id          INTEGER,
  raw_text            TEXT NOT NULL DEFAULT '',
  source_system       TEXT NOT NULL DEFAULT 'mock',
  external_id         TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  UNIQUE(source_system, external_id)
);

/* 內部群組的每一則貼文都先落這裡（稽核：哪一則解析成什麼、對到哪裡） */
CREATE TABLE IF NOT EXISTS group_posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'unknown',
  at            TEXT NOT NULL,
  sender        TEXT NOT NULL DEFAULT '',
  text          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'ignored',
  ref_table     TEXT NOT NULL DEFAULT '',
  ref_id        INTEGER,
  note          TEXT NOT NULL DEFAULT '',
  source_system TEXT NOT NULL DEFAULT 'mock',
  external_id   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  UNIQUE(source_system, external_id)
);

/* 資料上傳箱：公司丟進來的檔案（本體在 KV，這裡是中繼資料與處理結果） */
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  mime         TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'other',
  note         TEXT NOT NULL DEFAULT '',
  uploaded_by  TEXT NOT NULL DEFAULT '',
  uploaded_at  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'uploaded',
  result       TEXT NOT NULL DEFAULT '{}',
  processed_at TEXT,
  sha          TEXT NOT NULL DEFAULT '',
  kv_key       TEXT NOT NULL DEFAULT '',
  deleted_at   TEXT
);

/* 員工在各系統的名字（LINE 暱稱／Super 8 帳號／車源表寫法）→ 同一個 user */
CREATE TABLE IF NOT EXISTS staff_aliases (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  alias   TEXT NOT NULL UNIQUE,
  system  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_leads_contact    ON leads(contact_id, opened_at);
/* 2026-09-06：免費方案每天 500 萬列讀取，兩天撞頂兩次。原因是每個 lead 的查詢都在掃整張表：
   conversations 沒有 lead_id 索引（588 個 lead × 每次掃 588 列 × 漏斗／角色／行為／流失四趟）、deals／visits／evidence(loss_id)／assignment_log 也沒有。補齊後同一批分析少讀九成以上。 */
CREATE INDEX IF NOT EXISTS idx_conv_contact     ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_lead       ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_deals_staff      ON deals(staff_id, status);
CREATE INDEX IF NOT EXISTS idx_visits_lead      ON visits(lead_id, visited_at);
CREATE INDEX IF NOT EXISTS idx_evidence_lead    ON evidence(lead_id);
CREATE INDEX IF NOT EXISTS idx_assign_conv      ON assignment_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msg_sender       ON messages(sender_user_id);
CREATE INDEX IF NOT EXISTS idx_msg_conv_at      ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fe_lead_type     ON funnel_events(lead_id, type);
CREATE INDEX IF NOT EXISTS idx_leads_staff      ON leads(staff_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_leads_vehicle    ON leads(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_contacts_name    ON contacts(display_name);
CREATE INDEX IF NOT EXISTS idx_reports_lead     ON deal_reports(lead_id);
CREATE INDEX IF NOT EXISTS idx_documents_sha    ON documents(sha);
CREATE INDEX IF NOT EXISTS idx_reports_status   ON deal_reports(match_status, reported_at);
CREATE INDEX IF NOT EXISTS idx_appraisal_lead   ON appraisals(lead_id);
CREATE INDEX IF NOT EXISTS idx_posts_kind       ON group_posts(kind, status);
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
  /* 2026-09-05 真實資料流（docs/DATA_FLOW.md）：訊息組 vs 業務、共用座位、車源表欄位、送貨囉欄位、訊息來源與涵蓋 */
  ["users",         "job",              "TEXT NOT NULL DEFAULT ''"],
  ["users",         "seat_shared",      "INTEGER NOT NULL DEFAULT 0"],
  ["vehicles",      "cost_known",       "INTEGER NOT NULL DEFAULT 1"],
  ["vehicles",      "plate",            "TEXT NOT NULL DEFAULT ''"],
  ["vehicles",      "plate_norm",       "TEXT NOT NULL DEFAULT ''"],
  ["vehicles",      "color",            "TEXT NOT NULL DEFAULT ''"],
  ["vehicles",      "trim",             "TEXT NOT NULL DEFAULT ''"],
  ["vehicles",      "mileage_km",       "INTEGER"],
  ["vehicles",      "stock_in_at",      "TEXT"],
  ["vehicles",      "cert",             "TEXT NOT NULL DEFAULT ''"],
  ["vehicles",      "trade_price",      "INTEGER"],   // 舊欄位（2026-09-06 前叫這個），留著不用
  ["vehicles",      "sell_price",       "INTEGER"],   // 車源表「調作價」＝實賣價
  ["vehicles",      "source",           "TEXT NOT NULL DEFAULT 'stock'"],
  ["vehicles",      "peer_dealer",      "TEXT NOT NULL DEFAULT ''"],
  ["vehicles",      "status_text",      "TEXT NOT NULL DEFAULT ''"],
  ["conversations", "coverage",         "TEXT NOT NULL DEFAULT 'full'"],
  ["conversations", "coverage_note",    "TEXT NOT NULL DEFAULT ''"],
  ["messages",      "via",              "TEXT NOT NULL DEFAULT ''"],
  ["visits",        "source",           "TEXT NOT NULL DEFAULT 'ledger'"],
  ["visits",        "customer_ref",     "TEXT NOT NULL DEFAULT ''"],
  ["visits",        "model_text",       "TEXT NOT NULL DEFAULT ''"],
  ["visits",        "assigned_by",      "TEXT NOT NULL DEFAULT ''"],
  ["visits",        "raw_text",         "TEXT NOT NULL DEFAULT ''"],
  ["deals",         "plate",            "TEXT NOT NULL DEFAULT ''"],
  ["deals",         "customer_ref",     "TEXT NOT NULL DEFAULT ''"],
  ["deals",         "deposit",          "TEXT NOT NULL DEFAULT ''"],
  ["deals",         "loan_status",      "TEXT NOT NULL DEFAULT ''"],
  ["deals",         "delivery_by",      "TEXT NOT NULL DEFAULT ''"],
  ["deals",         "reported_by",      "TEXT NOT NULL DEFAULT ''"],
  ["deals",         "source_kind",      "TEXT NOT NULL DEFAULT 'stock'"],
  ["deals",         "peer_dealer",      "TEXT NOT NULL DEFAULT ''"],
  ["deals",         "cost_source",      "TEXT NOT NULL DEFAULT 'ledger'"],
  ["deals",         "gp_is_estimate",   "INTEGER NOT NULL DEFAULT 0"],
  ["deals",         "report_id",        "INTEGER"],
  ["deals",         "price_source",     "TEXT NOT NULL DEFAULT ''"],   // 售價從哪來：report／sheet_sell（調作價）／sheet_list（開價）
  ["deals",         "sheet_status",     "TEXT NOT NULL DEFAULT ''"],   // 車源表「目前狀況」原文（收訂(軒)…），車源表產生的才有
  ["deals",         "delivered",        "INTEGER NOT NULL DEFAULT 1"],   // 0＝成交但還沒交車（車源表 收訂／送貸／過件；Curry：收訂就算成交）
  ["behaviors",     "chat_staff_id",    "INTEGER"],
];

/** 索引的欄位是 ADD_COLUMNS 補上的 → 一定要在 ALTER 之後才能建（全新資料庫 2026-09-06 實測：先建索引會直接炸「no such column」） */
const LATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_conv_lead        ON conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_visits_source    ON visits(source);
CREATE INDEX IF NOT EXISTS idx_evidence_loss    ON evidence(loss_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate   ON vehicles(plate_norm);
CREATE INDEX IF NOT EXISTS idx_actions_status   ON actions(status, kind);
CREATE INDEX IF NOT EXISTS idx_fe_type_at      ON funnel_events(type, at, confidence);   -- 分析頁每種事件數本期／前期各一句（2 萬個 lead、30 萬個事件時沒這個要掃全表）
CREATE INDEX IF NOT EXISTS idx_conv_assigned   ON conversations(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_opened    ON leads(opened_at);
CREATE INDEX IF NOT EXISTS idx_leads_stage     ON leads(stage, outcome);
`;

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
  // 2026-09-06：車源表也會產生成交／收訂（沒有客戶），deals.contact_id 改成可為空。SQLite 不能直接拿掉 NOT NULL，只好重建一次（只會跑一次）
  const hasTable = (t: string) => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", t).toArray().length > 0;
  if (!hasTable("deals") && hasTable("deals_new")) { sql.exec("ALTER TABLE deals_new RENAME TO deals"); added.push("deals restored from deals_new"); }   // 上次重建做到一半
  const ci = sql.exec("PRAGMA table_info(deals)").toArray().find((c) => c["name"] === "contact_id");
  if (ci && Number(ci["notnull"]) === 1) {
    if (hasTable("deals_new")) sql.exec("DROP TABLE deals_new");
    const cols = "id, lead_id, contact_id, staff_id, vehicle_id, status, sale_price, cost, gross_profit, lost_reason, closed_at, external_key, source_system, plate, customer_ref, deposit, loan_status, delivery_by, reported_by, source_kind, peer_dealer, cost_source, gp_is_estimate, report_id, price_source, sheet_status, delivered";
    sql.exec(`CREATE TABLE deals_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER REFERENCES leads(id), contact_id INTEGER REFERENCES contacts(id), staff_id INTEGER REFERENCES users(id), vehicle_id INTEGER REFERENCES vehicles(id),
      status TEXT NOT NULL, sale_price INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0, gross_profit INTEGER NOT NULL DEFAULT 0, lost_reason TEXT NOT NULL DEFAULT '', closed_at TEXT NOT NULL,
      external_key TEXT NOT NULL DEFAULT '', source_system TEXT NOT NULL DEFAULT 'mock', plate TEXT NOT NULL DEFAULT '', customer_ref TEXT NOT NULL DEFAULT '', deposit TEXT NOT NULL DEFAULT '', loan_status TEXT NOT NULL DEFAULT '',
      delivery_by TEXT NOT NULL DEFAULT '', reported_by TEXT NOT NULL DEFAULT '', source_kind TEXT NOT NULL DEFAULT 'stock', peer_dealer TEXT NOT NULL DEFAULT '', cost_source TEXT NOT NULL DEFAULT 'ledger', gp_is_estimate INTEGER NOT NULL DEFAULT 0,
      report_id INTEGER, price_source TEXT NOT NULL DEFAULT '', sheet_status TEXT NOT NULL DEFAULT '', delivered INTEGER NOT NULL DEFAULT 1)`);
    sql.exec(`INSERT INTO deals_new (${cols}) SELECT ${cols} FROM deals`);
    sql.exec("DROP TABLE deals");
    sql.exec("ALTER TABLE deals_new RENAME TO deals");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_deals_lead ON deals(lead_id)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_deals_staff ON deals(staff_id, status)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_deals_closed ON deals(closed_at, status)");
    added.push("deals.contact_id nullable (rebuilt)");
  }
  sql.exec(LATE_INDEXES);
  // 舊資料的 sender_role 補值：out 是員工，in 是客戶
  sql.exec(`UPDATE messages SET sender_role = CASE direction WHEN 'out' THEN 'staff' ELSE 'customer' END
             WHERE sender_role = ''`);
  return { added };
}
