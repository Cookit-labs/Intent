.PHONY: all dev build test lint typecheck clean setup migrate generate contracts docker-up docker-down

# ── Top-level ──────────────────────────────────────────────────────────────────
all: build

dev:
	turbo run dev

build:
	turbo run build

test:
	turbo run test
	cd backend && go test ./...
	cd contracts && forge test

lint:
	turbo run lint
	cd backend && golangci-lint run ./...
	cd contracts && forge fmt --check

typecheck:
	turbo run typecheck

clean:
	turbo run clean
	cd backend && rm -rf bin/
	cd contracts && forge clean

# ── Setup ──────────────────────────────────────────────────────────────────────
setup:
	@echo "→ Checking prerequisites..."
	@command -v node >/dev/null 2>&1 || (echo "node not found" && exit 1)
	@command -v pnpm >/dev/null 2>&1 || (echo "pnpm not found — run: npm i -g pnpm" && exit 1)
	@command -v go >/dev/null 2>&1 || (echo "go not found" && exit 1)
	@command -v forge >/dev/null 2>&1 || (echo "foundry not found — run: curl -L https://foundry.paradigm.xyz | bash" && exit 1)
	@command -v docker >/dev/null 2>&1 || (echo "docker not found" && exit 1)
	@echo "→ Installing JS dependencies..."
	pnpm install
	@echo "→ Installing Go dependencies..."
	cd backend && go mod download
	@echo "→ Copying env files..."
	@[ -f .env ] || cp .env.example .env
	@[ -f backend/.env ] || cp backend/.env.example backend/.env
	@[ -f apps/website/.env.local ] || cp apps/website/.env.example apps/website/.env.local
	@[ -f apps/dapp/.env.local ] || cp apps/dapp/.env.example apps/dapp/.env.local
	@echo "→ Starting infrastructure..."
	$(MAKE) docker-up
	@echo "→ Running migrations..."
	$(MAKE) migrate
	@echo ""
	@echo "✓ Setup complete! Run 'make dev' to start."

# ── Database ───────────────────────────────────────────────────────────────────
migrate:
	cd backend && go run cmd/migrate/main.go up

migrate-down:
	cd backend && go run cmd/migrate/main.go down

generate:
	cd backend && sqlc generate
	@echo "✓ SQLC generated"

# ── Contracts ──────────────────────────────────────────────────────────────────
contracts:
	cd contracts && forge build

contracts-test:
	cd contracts && forge test -vvv

contracts-fmt:
	cd contracts && forge fmt

contracts-deploy-local:
	cd contracts && forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast

# ── Docker ─────────────────────────────────────────────────────────────────────
docker-up:
	docker compose -f tooling/docker/docker-compose.yml up -d

docker-down:
	docker compose -f tooling/docker/docker-compose.yml down

docker-logs:
	docker compose -f tooling/docker/docker-compose.yml logs -f

# ── Backend ────────────────────────────────────────────────────────────────────
backend-dev:
	cd backend && go run cmd/api/main.go

backend-build:
	cd backend && go build -o bin/api cmd/api/main.go