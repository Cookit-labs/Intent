-- Which asset a naira payout is deposited in: native XLM, or USDC after a swap.
-- amount_xlm keeps its name and holds the amount of this asset.
-- The application runs the same statement on first use; keep this in sync with
-- NAIRA_DDL in apps/dapp/lib/naira/orders.ts.

ALTER TABLE naira_orders ADD COLUMN IF NOT EXISTS coin TEXT NOT NULL DEFAULT 'xlm';
