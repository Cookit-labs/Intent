-- Who holds a cash-out order: Weave, or Linq where it pays more naira from Sui. Rows from before
-- are Weave's. The application runs the same statement on first use; keep this in sync with
-- WEAVE_DDL in apps/dapp/lib/weave/orders.ts.

ALTER TABLE weave_orders ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'weave';
