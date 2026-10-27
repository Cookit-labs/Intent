-- The winning agent's own explanation, kept beside its race so a user can see
-- why that plan was picked after the fact. Only ever written for the row
-- where won = true: a losing agent's prose was never acted on, so it is not
-- stored. The application runs the same statement on first use; keep this in
-- sync with ANALYTICS_DDL in apps/dapp/lib/server/analytics.ts.

ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS reasoning TEXT;
