-- What the fee sponsor has committed, per account per day, plus a `*` row
-- for the day as a whole. Both are bumped by the same statement so they
-- cannot drift, and the budget check reads them in one query. A sponsor key
-- is a balance anyone can drain by submitting; this is what bounds it.
--
-- This file only runs when the Postgres container is first initialised. An
-- existing database never sees it, so apps/dapp/lib/server/sponsor-ledger.ts
-- runs the same idempotent statements on first use. Keep the two in sync.

CREATE TABLE IF NOT EXISTS sponsor_ledger (
  day      DATE    NOT NULL,
  -- A Stellar public key, or `*` for the day's total.
  account  TEXT    NOT NULL,
  -- Fees committed, in stroops. What the bump names as its maximum, so a
  -- transaction that fails on-chain is still counted; the budget is a cap,
  -- and a cap that over-counts errs the right way.
  stroops  BIGINT  NOT NULL DEFAULT 0,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, account)
);
