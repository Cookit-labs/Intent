-- Fixed-window request counters: one row per (key, window), bumped by a
-- single upsert per request. Held in Postgres rather than in memory so the
-- limit holds across serverless instances, and rather than in Redis because
-- only the OTP flow uses Redis and a second store for one counter is a
-- second thing that can fail.
--
-- This file only runs when the Postgres container is first initialised. An
-- existing database never sees it, so apps/dapp/lib/server/rate-limit.ts
-- runs the same idempotent statements on first use. Keep the two in sync.

CREATE TABLE IF NOT EXISTS rate_limits (
  -- `ip:<address>:<family>` or `account:<G...>:<family>`.
  key          TEXT        NOT NULL,
  -- The window's start, aligned to a multiple of the family's window length.
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- Old windows are purged by age.
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);
