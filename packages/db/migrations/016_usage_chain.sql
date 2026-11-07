-- The chain each transaction and each typed instruction ran on, so the admin counts every chain
-- and can show them apart. The application runs the same statements on first use; keep this in
-- sync with ANALYTICS_DDL in apps/dapp/lib/server/analytics.ts.

ALTER TABLE usage_executions ADD COLUMN IF NOT EXISTS chain TEXT;
CREATE INDEX IF NOT EXISTS usage_executions_chain_idx ON usage_executions (network, chain, submitted_at);

-- Other chains' transactions used to be logged under their chain's name as the kind.
UPDATE usage_executions SET chain = kind, kind = 'unknown'
  WHERE chain IS NULL AND kind IN ('solana', 'sui', 'near', 'avalanche', 'monad');

-- A cash-out names its chain only in its order, matched on the deposit hash.
DO $$ BEGIN
  IF to_regclass('weave_orders') IS NOT NULL THEN
    UPDATE usage_executions e SET
      chain = w.chain,
      asset_in = coalesce(e.asset_in, 'USDC'),
      amount_in = coalesce(e.amount_in, w.amount::numeric),
      volume_usd = coalesce(e.volume_usd, w.amount::numeric)
    FROM weave_orders w
    WHERE e.chain IS NULL AND e.kind = 'offramp' AND e.hash IS NOT NULL
      AND w.deposit_hash = e.hash AND w.amount ~ '^[0-9]+([.][0-9]+)?$';
  END IF;
END $$;

UPDATE usage_executions SET chain = 'stellar' WHERE chain IS NULL;

ALTER TABLE intent_reads ADD COLUMN IF NOT EXISTS chain TEXT;
