-- name: GetCurrentLeaderboard :many
SELECT DISTINCT ON (agent_id) *
FROM leaderboard_snapshots
ORDER BY agent_id, snapshot_at DESC, rank ASC
LIMIT $1;

-- name: InsertLeaderboardSnapshot :one
INSERT INTO leaderboard_snapshots (agent_id, rank, reputation_score, win_rate, total_executions, avg_slippage)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;