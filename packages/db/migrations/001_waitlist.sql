-- Access control for private testing.
--
-- One table, not two: an "allowlist" and a "waitlist" would be the same rows in
-- different states, and splitting them invites the two to disagree about who is
-- accepted. Status is the single source of truth.

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id            BIGSERIAL PRIMARY KEY,
  -- Stored lowercased and trimmed by the application so that a lookup can never
  -- miss an accepted user on capitalisation alone.
  email         TEXT        NOT NULL UNIQUE,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected')),
  -- Free-text context from the signup form; not used for access decisions.
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at   TIMESTAMPTZ,
  -- Set on first successful OTP verification, so we can tell "invited" from
  -- "actually showed up".
  first_login_at TIMESTAMPTZ
);

-- Every request-otp call looks a user up by email, so this index is on the hot
-- path of the gate.
CREATE INDEX IF NOT EXISTS waitlist_signups_status_idx ON waitlist_signups (status);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS waitlist_signups_updated_at ON waitlist_signups;
CREATE TRIGGER waitlist_signups_updated_at
  BEFORE UPDATE ON waitlist_signups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
