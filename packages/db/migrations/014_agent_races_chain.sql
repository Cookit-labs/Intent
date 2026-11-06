-- The chain each agent race ran on. Races from before other chains ran were all Stellar's.
-- The application runs the same statement on first use; keep this in sync with
-- ANALYTICS_DDL in apps/dapp/lib/server/analytics.ts.

ALTER TABLE agent_races ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'stellar';
