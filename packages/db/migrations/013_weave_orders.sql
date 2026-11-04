-- Cash-out orders through Weave, on every chain it pays out from.
-- The application runs the same statements on first use; keep this in sync with
-- WEAVE_DDL in apps/dapp/lib/weave/orders.ts.

CREATE TABLE IF NOT EXISTS weave_orders (
  id                 UUID        PRIMARY KEY,
  chain              TEXT        NOT NULL,
  email              TEXT        NOT NULL,
  account            TEXT        NOT NULL,
  provider_order     TEXT        NOT NULL UNIQUE,
  idempotency_key    TEXT        NOT NULL UNIQUE,
  currency           TEXT        NOT NULL,
  institution_code   TEXT        NOT NULL,
  institution_name   TEXT        NOT NULL,
  account_identifier TEXT        NOT NULL,
  account_name       TEXT        NOT NULL,
  deposit_address    TEXT        NOT NULL,
  deposit_memo       TEXT,
  amount             TEXT        NOT NULL,
  estimated_dest     TEXT        NOT NULL,
  expires_at         TIMESTAMPTZ,
  status             TEXT        NOT NULL,
  provider_status    TEXT        NOT NULL,
  deposit_hash       TEXT        UNIQUE,
  send_started_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS weave_orders_email_idx ON weave_orders (email, created_at);
CREATE INDEX IF NOT EXISTS weave_orders_account_idx ON weave_orders (account, created_at);
