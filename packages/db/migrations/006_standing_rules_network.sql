-- Standing rules belong to a Stellar network. Rules written before there were
-- two networks belong to the one the deployment was serving: replace 'testnet'
-- below with that network before running this against a database that serves
-- mainnet. The application runs the same statements on first use, with the
-- deployment's own default network.
ALTER TABLE standing_rules ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'testnet';
CREATE INDEX IF NOT EXISTS standing_rules_network_idx ON standing_rules (network, status);
