-- 0018 — Catalog sealing: chunks are frozen while a seal runs, and the seal commits only
-- if the chunks it validated are still exactly the ones stored
-- =====================================================================================
-- A seal first marks the upload 'sealing' with its own token (chunk writes require
-- status 'open' inside the write itself), validates the frozen chunks, then commits in one
-- D1 batch whose first statement re-checks the token and the exact (table, part, sha256)
-- set it validated; every later statement in the batch is conditional on that check.
-- A seal that fails returns the upload to 'open'; a sealed upload answers repeats with its
-- stored result. A 'sealing' upload left by a Worker that died is taken over after 60 s.
ALTER TABLE catalog_upload ADD COLUMN seal_token TEXT;
ALTER TABLE catalog_upload ADD COLUMN sealing_at TEXT;
ALTER TABLE catalog_upload ADD COLUMN catalog_rev TEXT;
-- result: JSON, the seal's answer, replayed to a repeated seal
ALTER TABLE catalog_upload ADD COLUMN result TEXT;
