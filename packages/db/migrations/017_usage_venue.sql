-- Where each transaction ran and exactly what it did, so a wallet's history can say "Deposit on
-- NAVI" and not only that some lending happened. Older rows stay null: nothing recorded them. The
-- application runs the same statements on first use; keep this in sync with ANALYTICS_DDL in
-- apps/dapp/lib/server/analytics.ts.

ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS venue TEXT;
ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS action TEXT;
