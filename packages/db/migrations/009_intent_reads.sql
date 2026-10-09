-- How each typed instruction was read by the model: the action, tokens and size it
-- understood, or the fixed reason it did not. The sentence itself is never stored.
-- The application runs the same statements on first use; keep this in sync with
-- ANALYTICS_DDL in apps/dapp/lib/server/analytics.ts.

CREATE TABLE IF NOT EXISTS intent_reads (
  id         UUID        PRIMARY KEY,
  network    TEXT        NOT NULL,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  understood BOOLEAN     NOT NULL,
  action     TEXT,
  token_in   TEXT,
  token_out  TEXT,
  size_usd   NUMERIC,
  reason     TEXT
);
CREATE INDEX IF NOT EXISTS intent_reads_time_idx ON intent_reads (network, read_at);
