-- Intent's usage log: one row per transaction submitted through the app, and one
-- per agent competition and per agent in it. No amounts, prices, emails or typed
-- text. What a transaction moved is read back from the chain with the hash.
-- The application runs the same statements on first use; keep this in sync with
-- ANALYTICS_DDL in apps/dapp/lib/server/analytics.ts.

CREATE TABLE IF NOT EXISTS executions (
  id            UUID        PRIMARY KEY,
  network       TEXT        NOT NULL,
  hash          TEXT,
  account       TEXT        NOT NULL,
  kind          TEXT        NOT NULL,
  fee_sponsored BOOLEAN     NOT NULL,
  ok            BOOLEAN     NOT NULL,
  failure       TEXT,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS executions_hash_idx ON executions (network, hash) WHERE hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS executions_time_idx ON executions (network, submitted_at);
CREATE INDEX IF NOT EXISTS executions_account_idx ON executions (network, account);

CREATE TABLE IF NOT EXISTS agent_races (
  id          UUID        PRIMARY KEY,
  network     TEXT        NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  intent_type TEXT        NOT NULL,
  token_in    TEXT        NOT NULL,
  token_out   TEXT        NOT NULL,
  size_usd    NUMERIC,
  agents      INTEGER     NOT NULL,
  answered    INTEGER     NOT NULL,
  winner      TEXT,
  unanimous   BOOLEAN,
  outcome     TEXT        NOT NULL CHECK (outcome IN ('winner', 'no_winner', 'no_agent_answered')),
  duration_ms INTEGER     NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_races_time_idx ON agent_races (network, started_at);

CREATE TABLE IF NOT EXISTS agent_proposals (
  race_id        UUID    NOT NULL REFERENCES agent_races (id),
  agent          TEXT    NOT NULL,
  model          TEXT,
  ok             BOOLEAN NOT NULL,
  failure        TEXT,
  latency_ms     INTEGER NOT NULL,
  score          NUMERIC,
  won            BOOLEAN NOT NULL,
  route_id       TEXT,
  execution_mode TEXT,
  PRIMARY KEY (race_id, agent)
);

-- A read-only role for the analytics dashboard. Create it once per database and
-- give it a password outside version control:
--   CREATE ROLE intent_analytics_ro LOGIN PASSWORD '<from a secret store>';
--   GRANT CONNECT ON DATABASE <db> TO intent_analytics_ro;
--   GRANT USAGE ON SCHEMA public TO intent_analytics_ro;
--   GRANT SELECT ON executions, agent_races, agent_proposals, sponsor_ledger TO intent_analytics_ro;
-- It is deliberately not granted standing_rules, waitlist_signups or anything else.
