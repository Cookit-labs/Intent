-- What each submitted transaction sold, read from its own signed bytes and priced
-- by the app at the time, so volume can be counted. Null when the envelope could
-- not be read or the asset could not be priced; the hash stays beside it so any
-- figure can be checked against the ledger. The application runs the same
-- statements on first use; keep this in sync with ANALYTICS_DDL in
-- apps/dapp/lib/server/analytics.ts.

ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS asset_in   TEXT;
ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS asset_out  TEXT;
ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS amount_in  NUMERIC;
ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS volume_usd NUMERIC;
