-- Naira payouts: one row per cash-out order. The bank account number lives here
-- and only here; it is never written to chat history, logs or analytics.
-- The application runs the same statement on first use; keep this in sync with
-- NAIRA_DDL in apps/dapp/lib/naira/orders.ts.

CREATE TABLE IF NOT EXISTS naira_orders (
  id              UUID        PRIMARY KEY,
  network         TEXT        NOT NULL,
  email           TEXT        NOT NULL,
  account         TEXT        NOT NULL,
  provider_order  TEXT        NOT NULL UNIQUE,
  idempotency_key TEXT        NOT NULL UNIQUE,
  bank_code       TEXT        NOT NULL,
  bank_name       TEXT        NOT NULL,
  account_number  TEXT        NOT NULL,
  account_name    TEXT        NOT NULL,
  deposit_address TEXT        NOT NULL,
  amount_xlm      NUMERIC     NOT NULL,
  amount_ngn      NUMERIC     NOT NULL,
  rate            NUMERIC     NOT NULL,
  status          TEXT        NOT NULL,
  provider_status TEXT        NOT NULL,
  payment_hash    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS naira_orders_email_idx ON naira_orders (email, created_at);
