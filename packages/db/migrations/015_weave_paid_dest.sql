-- What a paid Weave order actually paid out, kept beside the estimate it was made with, which
-- fees and the payout rate can leave it below. The application runs the same statement on first
-- use; keep this in sync with WEAVE_DDL in apps/dapp/lib/weave/orders.ts.

ALTER TABLE weave_orders ADD COLUMN IF NOT EXISTS paid_dest TEXT;
