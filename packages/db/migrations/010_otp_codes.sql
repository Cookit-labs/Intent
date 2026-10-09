-- Sign-in codes. One row per address: the hash of the live code, when it expires,
-- how many tries it has had, and when and how often a code was last sent.
-- Replaces the Redis keys the store used before, so sign-in needs only Postgres.
-- The application runs the same statement on first use; keep this in sync with
-- OTP_DDL in apps/dapp/lib/server/otp.ts.

CREATE TABLE IF NOT EXISTS otp_codes (
  email        TEXT        PRIMARY KEY,
  code_hash    TEXT,
  expires_at   TIMESTAMPTZ,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sends        INTEGER     NOT NULL DEFAULT 0
);
