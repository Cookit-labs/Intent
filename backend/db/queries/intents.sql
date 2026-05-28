-- name: CreateIntent :one
INSERT INTO intents (user_id, intent_type, token_in, token_out, amount_in, min_amount_out, deadline)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetIntent :one
SELECT * FROM intents WHERE id = $1 LIMIT 1;

-- name: ListIntentsByUser :many
SELECT * FROM intents WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3;

-- name: UpdateIntentStatus :one
UPDATE intents SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *;