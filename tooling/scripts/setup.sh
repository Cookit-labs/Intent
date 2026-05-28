#!/usr/bin/env bash
set -euo pipefail

echo "═══════════════════════════════════════"
echo "  Intent — Development Setup"
echo "═══════════════════════════════════════"

# ── Prerequisites check ───────────────────────────────────────────
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "✗ $1 not found. $2"
    exit 1
  fi
  echo "✓ $1"
}

echo ""
echo "→ Checking prerequisites..."
check_cmd "node"   "Install from https://nodejs.org (v22+)"
check_cmd "pnpm"   "Run: npm install -g pnpm"
check_cmd "go"     "Install from https://go.dev"
check_cmd "docker" "Install from https://docker.com"

# Foundry is optional for initial dev
if command -v forge &>/dev/null; then
  echo "✓ forge"
else
  echo "⚠ forge not found — install Foundry to work with contracts"
  echo "  curl -L https://foundry.paradigm.xyz | bash && foundryup"
fi

# ── JS dependencies ───────────────────────────────────────────────
echo ""
echo "→ Installing JS dependencies..."
pnpm install

# ── Environment files ─────────────────────────────────────────────
echo ""
echo "→ Setting up environment files..."
[ -f .env ]                  || cp .env.example .env
[ -f backend/.env ]          || cp backend/.env.example backend/.env
[ -f apps/website/.env.local ] || cp apps/website/.env.example apps/website/.env.local
[ -f apps/dapp/.env.local ]    || cp apps/dapp/.env.example apps/dapp/.env.local

echo "  ⚠ Edit .env files and fill in your API keys before running the full stack"

# ── Go dependencies ───────────────────────────────────────────────
echo ""
echo "→ Installing Go dependencies..."
(cd backend && go mod download)

# ── Infrastructure ────────────────────────────────────────────────
echo ""
echo "→ Starting Docker infrastructure..."
docker compose -f tooling/docker/docker-compose.yml up -d postgres redis

echo ""
echo "→ Waiting for Postgres..."
until docker compose -f tooling/docker/docker-compose.yml exec -T postgres pg_isready -U intent &>/dev/null; do
  sleep 1
done

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  ✓ Setup complete!"
echo ""
echo "  Start development:"
echo "    make dev              → start all apps"
echo "    make backend-dev      → start Go API only"
echo "    make docker-up        → start all infra"
echo ""
echo "  URLs:"
echo "    Website   → http://localhost:3000"
echo "    dApp      → http://localhost:3001"
echo "    API       → http://localhost:8080"
echo "    Grafana   → http://localhost:3003"
echo "    Jaeger    → http://localhost:16686"
echo "═══════════════════════════════════════"