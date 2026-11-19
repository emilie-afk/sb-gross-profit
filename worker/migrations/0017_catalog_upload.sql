-- 0017 — Chunked cost-catalog upload (Workers Free: bounded per-request CPU)
-- =========================================================================
-- build.py pushes the catalog as ≤ 64 KB chunks of key-sorted table entries instead of
-- one ~360 KB request. Each chunk is validated and stored as the exact text fragment of
-- its table's canonical JSON; sealing checks completeness, key order and the counts,
-- then copies the fragments into cost_catalog_part inside D1 (no re-read in the Worker).
-- The revision of a chunked catalog is the hash of its parts' hashes (catalogPartsRevOf).
CREATE TABLE IF NOT EXISTS catalog_upload (
  upload_id      TEXT PRIMARY KEY,               -- cup_<id>
  status         TEXT NOT NULL,                  -- open | sealed
  layout         TEXT NOT NULL,                  -- JSON: [[table, depth, n | [[groupKey, n], ...]], ...]
  meta           TEXT NOT NULL,                  -- JSON: builtAt, commit, refreshId, source, mcgExtra count
  created_at     TEXT NOT NULL,
  sealed_at      TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS catalog_upload_part (
  upload_id      TEXT NOT NULL,
  table_name     TEXT NOT NULL,
  part           INTEGER NOT NULL,
  grp            TEXT,                           -- depth-2 tables: the group key (vendor)
  first_key      TEXT,
  last_key       TEXT,
  n              INTEGER NOT NULL,               -- entries in this chunk
  sha256         TEXT NOT NULL,                  -- of payload
  payload        TEXT NOT NULL,                  -- exact fragment of the table's canonical JSON text
  PRIMARY KEY (upload_id, table_name, part)
) WITHOUT ROWID;
