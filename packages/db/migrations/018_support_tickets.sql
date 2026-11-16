-- Help tickets raised from the help button, and the thread with the team after each. The application
-- runs the same statements on first use; keep this in sync with SUPPORT_DDL in
-- apps/dapp/lib/support/tickets.ts.

CREATE TABLE IF NOT EXISTS support_tickets (
  id          TEXT        PRIMARY KEY,
  requester   TEXT        NOT NULL,
  wallet      TEXT,
  chain       TEXT,
  kind        TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'open',
  title       TEXT        NOT NULL,
  summary     TEXT        NOT NULL,
  context     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  user_unread BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_requester ON support_tickets (requester, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id         BIGSERIAL   PRIMARY KEY,
  ticket_id  TEXT        NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
  author     TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_ticket ON support_messages (ticket_id, id);
