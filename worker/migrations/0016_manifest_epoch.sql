-- 0016 — Free-tier: the input epoch a manifest was assembled at
-- ===========================================================
-- GET /v1/collect/weeks/:w/manifest returns the epoch with the manifest, signed together.
-- Finalize compares it with the current epoch: unchanged means no input was written since
-- the manifest was assembled, so the manifest is still exact and need not be rebuilt (the
-- commit transaction re-checks the same epoch). A moved epoch falls back to rebuilding the
-- manifest and comparing it with the pinned one.
ALTER TABLE result_upload ADD COLUMN manifest_epoch INTEGER;
