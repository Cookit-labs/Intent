-- Operator alerts that have gone out: one row per kind per day, so the tick
-- that raises them can tell an operator once about a low sponsor balance and
-- not again until tomorrow. Nothing here is user data.
--
-- This file only runs when the Postgres container is first initialised. An
-- existing database never sees it, so apps/dapp/lib/server/alerts.ts runs
-- the same idempotent statement on first use. Keep the two in sync.

CREATE TABLE IF NOT EXISTS alerts_sent (
  kind    TEXT        NOT NULL,
  -- The UTC date of the tick that sent it.
  day     DATE        NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, day)
);
