-- name: CreateAgent :one
INSERT INTO agents (address, name, strategy_type) VALUES ($1, $2, $3) RETURNING *;

-- name: GetAgent :one
SELECT * FROM agents WHERE id = $1 LIMIT 1;

-- name: GetAgentByAddress :one
SELECT * FROM agents WHERE address = $1 LIMIT 1;

-- name: ListActiveAgents :many
SELECT * FROM agents WHERE is_active = TRUE ORDER BY registered_at DESC;