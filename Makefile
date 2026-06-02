.PHONY: all dev build test lint typecheck clean setup format

# ── Top-level ──────────────────────────────────────────────────────────────────
all: build

dev:
	turbo run dev

build:
	turbo run build

test:
	turbo run test

lint:
	turbo run lint

typecheck:
	turbo run typecheck

format:
	pnpm format

format-check:
	pnpm format:check

clean:
	turbo run clean

# ── Setup ──────────────────────────────────────────────────────────────────────
setup:
	@echo "→ Checking prerequisites..."
	@command -v node >/dev/null 2>&1 || (echo "node not found" && exit 1)
	@command -v pnpm >/dev/null 2>&1 || (echo "pnpm not found — run: npm i -g pnpm" && exit 1)
	@echo "→ Installing JS dependencies..."
	pnpm install
	@echo "→ Copying env files..."
	@[ -f apps/website/.env.local ] || cp apps/website/.env.example apps/website/.env.local
	@[ -f apps/dapp/.env.local ] || cp apps/dapp/.env.example apps/dapp/.env.local
	@echo ""
	@echo "✓ Setup complete! Run 'make dev' to start."
