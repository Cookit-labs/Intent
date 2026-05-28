-- Intent Protocol — Initial Schema
-- Run: migrate -path ./db/migrations -database $DATABASE_URL up

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE users (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  address    VARCHAR(42) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agents
CREATE TABLE agents (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  address          VARCHAR(42) UNIQUE NOT NULL,
  name             VARCHAR(255) NOT NULL,
  strategy_type    VARCHAR(50)  NOT NULL,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  registry_tx_hash VARCHAR(66)
);

-- Intents
CREATE TABLE intents (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id),
  intent_type         VARCHAR(50) NOT NULL,
  token_in            VARCHAR(42) NOT NULL,
  token_out           VARCHAR(42) NOT NULL,
  amount_in           NUMERIC(78, 0) NOT NULL,
  min_amount_out      NUMERIC(78, 0) NOT NULL,
  deadline            TIMESTAMPTZ NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending',
  escrow_tx_hash      VARCHAR(66),
  settlement_tx_hash  VARCHAR(66),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Competitions
CREATE TABLE competitions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  intent_id        UUID NOT NULL REFERENCES intents(id),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at          TIMESTAMPTZ NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'open',
  winner_agent_id  UUID REFERENCES agents(id),
  winner_proposal_id UUID
);

-- Competition Proposals
CREATE TABLE competition_proposals (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  competition_id      UUID NOT NULL REFERENCES competitions(id),
  agent_id            UUID NOT NULL REFERENCES agents(id),
  projected_amount_out NUMERIC(78, 0) NOT NULL,
  projected_slippage  NUMERIC(10, 6) NOT NULL,
  quality_score       NUMERIC(5, 2) NOT NULL DEFAULT 0,
  total_score         NUMERIC(5, 2) NOT NULL DEFAULT 0,
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Executions
CREATE TABLE executions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  competition_id    UUID NOT NULL REFERENCES competitions(id),
  agent_id          UUID NOT NULL REFERENCES agents(id),
  intent_id         UUID NOT NULL REFERENCES intents(id),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  actual_amount_out NUMERIC(78, 0),
  actual_slippage   NUMERIC(10, 6),
  tx_hash           VARCHAR(66),
  executed_at       TIMESTAMPTZ,
  settled_at        TIMESTAMPTZ
);

-- Reputation History
CREATE TABLE reputation_history (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id      UUID NOT NULL REFERENCES agents(id),
  score_before  NUMERIC(10, 4) NOT NULL,
  score_after   NUMERIC(10, 4) NOT NULL,
  delta         NUMERIC(10, 4) NOT NULL,
  event_type    VARCHAR(20) NOT NULL,
  execution_id  UUID REFERENCES executions(id),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Settlements
CREATE TABLE settlements (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  execution_id   UUID NOT NULL REFERENCES executions(id),
  usdc_amount    NUMERIC(78, 0) NOT NULL,
  protocol_fee   NUMERIC(78, 0) NOT NULL,
  net_amount     NUMERIC(78, 0) NOT NULL,
  tx_hash        VARCHAR(66),
  status         VARCHAR(20) NOT NULL DEFAULT 'pending',
  settled_at     TIMESTAMPTZ
);

-- Leaderboard Snapshots
CREATE TABLE leaderboard_snapshots (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id          UUID NOT NULL REFERENCES agents(id),
  rank              INTEGER NOT NULL,
  reputation_score  NUMERIC(10, 4) NOT NULL,
  win_rate          NUMERIC(5, 4) NOT NULL,
  total_executions  INTEGER NOT NULL DEFAULT 0,
  avg_slippage      NUMERIC(10, 6) NOT NULL DEFAULT 0,
  snapshot_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_intents_user_status ON intents(user_id, status);
CREATE INDEX idx_intents_status_created ON intents(status, created_at DESC);
CREATE INDEX idx_competitions_intent ON competitions(intent_id);
CREATE INDEX idx_competitions_status_ends ON competitions(status, ends_at);
CREATE INDEX idx_proposals_competition ON competition_proposals(competition_id);
CREATE INDEX idx_proposals_agent ON competition_proposals(agent_id, submitted_at);
CREATE INDEX idx_executions_agent_status ON executions(agent_id, status);
CREATE INDEX idx_executions_intent ON executions(intent_id);
CREATE INDEX idx_reputation_agent_time ON reputation_history(agent_id, recorded_at DESC);
CREATE INDEX idx_leaderboard_snapshot_time ON leaderboard_snapshots(snapshot_at DESC, rank);