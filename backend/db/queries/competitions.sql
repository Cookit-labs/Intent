-- name: CreateCompetition :one
INSERT INTO competitions (intent_id, ends_at) VALUES ($1, $2) RETURNING *;

-- name: GetCompetition :one
SELECT * FROM competitions WHERE id = $1 LIMIT 1;

-- name: GetActiveCompetitionByIntent :one
SELECT * FROM competitions WHERE intent_id = $1 AND status = 'open' LIMIT 1;

-- name: UpdateCompetitionWinner :one
UPDATE competitions SET status = 'closed', winner_agent_id = $2, winner_proposal_id = $3
WHERE id = $1 RETURNING *;