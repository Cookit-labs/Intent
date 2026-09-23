-- Standing rules: "buy XLM if it drops to $0.16", "every Monday swap 50 USDC
-- to XLM". Held here so a scheduled tick can evaluate them with no browser
-- open. Firing is a prompt to sign, never an execution: nothing in this table
-- moves funds, and the user still approves every trade in their wallet.
--
-- This file only runs when the Postgres container is first initialised. An
-- existing database never sees it, so apps/dapp/lib/server/standing-rules.ts
-- runs the same idempotent statements on first use. Keep the two in sync.

CREATE TABLE IF NOT EXISTS standing_rules (
  id            TEXT        PRIMARY KEY,
  -- The session's email; every read and write is scoped by it.
  email         TEXT        NOT NULL,
  -- The wallet the rule would trade from, as the client reported it.
  wallet        TEXT        NOT NULL,
  chain         TEXT        NOT NULL,
  -- The client's StandingIntent, stored as sent. The columns below are the
  -- record for anything the server decides; the JSON's own status is not.
  rule          JSONB       NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'armed'
                CHECK (status IN ('armed', 'fired', 'cancelled', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When the condition was last met. A scheduled rule measures its next
  -- interval from here and stays armed; a one-off rule becomes 'fired'.
  fired_at      TIMESTAMPTZ,
  fired_price   NUMERIC,
  -- When the owner was emailed about the firing. Null after a firing until the
  -- send succeeds, so a failed send is retried by the next tick.
  notified_at   TIMESTAMPTZ,
  -- When the owner opened the in-app inbox and saw the firing.
  seen_at       TIMESTAMPTZ
);

-- The tick reads every armed rule; the inbox and the list read one owner's.
CREATE INDEX IF NOT EXISTS standing_rules_status_idx ON standing_rules (status);
CREATE INDEX IF NOT EXISTS standing_rules_owner_idx ON standing_rules (email, chain);
