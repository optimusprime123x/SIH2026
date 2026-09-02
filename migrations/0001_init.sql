-- LMPC Compliance Checker — inspection repository schema (D1 / SQLite)

CREATE TABLE IF NOT EXISTS inspections (
  id              TEXT PRIMARY KEY,               -- LMPC-YYYYMMDD-XXXX
  ts              TEXT NOT NULL,                  -- ISO timestamp of the scan
  role            TEXT,                           -- inspector | admin
  model           TEXT,                           -- extraction engine
  mock            INTEGER NOT NULL DEFAULT 0,
  brand           TEXT,
  product         TEXT,
  category        TEXT,
  gtin            TEXT,                           -- first decoded product barcode
  verdict         TEXT NOT NULL,                  -- rules-engine verdict
  final_verdict   TEXT NOT NULL,                  -- admin override if any, else verdict
  summary         TEXT,
  override_json   TEXT,                           -- {verdict, reason, by, ts} or NULL
  extraction_json TEXT NOT NULL,                  -- Gemini extraction (verbatim label data)
  results_json    TEXT NOT NULL,                  -- rules-engine results incl. resolutions
  barcodes_json   TEXT,                           -- [{format, value}]
  image_count     INTEGER NOT NULL DEFAULT 0,     -- images live in R2 at inspections/{id}/{n}.jpg
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inspections_ts ON inspections (ts DESC);
CREATE INDEX IF NOT EXISTS idx_inspections_gtin ON inspections (gtin);
CREATE INDEX IF NOT EXISTS idx_inspections_final_verdict ON inspections (final_verdict);

-- One row per effective violation/missing declaration, for dashboard aggregation.
CREATE TABLE IF NOT EXISTS violations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id TEXT NOT NULL REFERENCES inspections (id) ON DELETE CASCADE,
  check_id      TEXT NOT NULL,
  clause        TEXT NOT NULL,
  title         TEXT,
  status        TEXT NOT NULL,                    -- violation | missing
  severity      TEXT                              -- critical | major | minor
);

CREATE INDEX IF NOT EXISTS idx_violations_inspection ON violations (inspection_id);
CREATE INDEX IF NOT EXISTS idx_violations_clause ON violations (clause);
