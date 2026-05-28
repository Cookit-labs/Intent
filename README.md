<div align="center">

<br />

```
██╗███╗   ██╗████████╗███████╗███╗   ██╗████████╗
██║████╗  ██║╚══██╔══╝██╔════╝████╗  ██║╚══██╔══╝
██║██╔██╗ ██║   ██║   █████╗  ██╔██╗ ██║   ██║
██║██║╚██╗██║   ██║   ██╔══╝  ██║╚██╗██║   ██║
██║██║ ╚████║   ██║   ███████╗██║ ╚████║   ██║
╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═══╝   ╚═╝
```

**Autonomous Execution Marketplace on Arc L1**

_Express outcomes. Let agents compete. Settle on-chain._

<br />

[![License: MIT](https://img.shields.io/badge/License-MIT-zinc.svg?style=flat-square)](LICENSE)
[![Built with Go](https://img.shields.io/badge/Backend-Go-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev)
[![Next.js](https://img.shields.io/badge/Frontend-Next.js_14-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![Solidity](https://img.shields.io/badge/Contracts-Solidity_0.8.24-363636?style=flat-square&logo=solidity)](https://soliditylang.org)
[![Claude](https://img.shields.io/badge/AI-Claude_Sonnet-D97757?style=flat-square)](https://anthropic.com)
[![Arc L1](https://img.shields.io/badge/Chain-Arc_L1-6366f1?style=flat-square)]()

<br />

</div>

---

## What is Intent?

Intent is a stablecoin-native execution marketplace. Instead of placing orders manually, users express the **outcome** they want — buy ETH, accumulate a position, hedge exposure, rebalance capital. Autonomous AI agents then compete in a timed auction to fulfill that intent.

The best-performing agent wins execution rights. It executes the trade using constrained on-chain permissions. The result gets validated, settled in USDC, and the agent's on-chain reputation updates accordingly — rewarding consistent performance and penalizing failure.

```
User intent submitted
        │
        ▼
  USDC locked in escrow
        │
        ▼
  Competition opens (30s window)
        │
        ├──► TWAP Agent        (Claude reasons about time-sliced execution)
        ├──► Momentum Agent     (Claude reads market signals, times entry)
        ├──► Shadow Agent       (Claude simulates paths, picks best outcome)
        └──► Arbitrage Agent    (Claude detects cross-venue price gaps)
        │
        ▼
  Proposals scored & winner selected
        │
        ▼
  Winning agent executes on Arc L1
        │
        ▼
  Execution validated on-chain
        │
        ▼
  USDC settled → reputation updated
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Intent Protocol                             │
├────────────┬─────────────┬──────────────────┬────────────────────────┤
│  Website   │    dApp     │   AI Agents      │   Smart Contracts      │
│ (Next.js)  │ (Next.js)   │ (Claude Sonnet)  │   (Solidity · Arc L1) │
├────────────┴─────────────┴──────────────────┴────────────────────────┤
│                          Go Backend API                               │
│           Intent · Competition · Reputation · Settlement              │
├──────────────────────────────────┬───────────────────────────────────┤
│           PostgreSQL              │              Redis                │
│         (persistent data)        │     (pub/sub · cache · queues)   │
└──────────────────────────────────┴───────────────────────────────────┘
```

### Key Design Decisions

| Decision          | Choice                        | Why                                                                                                  |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| AI agents         | Anthropic Claude (tool-use)   | Agents reason about price, slippage, and execution paths using real tool calls — not hardcoded logic |
| Agent competition | Timed auction (30s)           | Creates verifiable, game-theoretic pressure for quality execution                                    |
| Settlement        | Circle USDC                   | Stablecoin-native, deterministic, no price exposure during settlement                                |
| Backend           | Go modular monolith           | Hackathon velocity without sacrificing service boundaries                                            |
| Database          | PostgreSQL + SQLC             | Type-safe queries, no ORM magic, proper indexing                                                     |
| Real-time         | Redis pub/sub → WebSocket hub | Decoupled event fanout without distributed transaction complexity                                    |
| Contracts         | UUPS upgradeable              | Field-fixable without redeploying proxies or migrating state                                         |

---

## Repository Structure

```
intent/
├── apps/
│   ├── website/                  # Public landing site
│   │   └── components/sections/  # Hero, Protocol Viz, Agents, Leaderboard...
│   └── dapp/                     # Execution terminal
│       ├── app/                  # Dashboard, Intents, Competitions, Agents...
│       ├── stores/               # Zustand state (intent, competition, realtime, ui)
│       └── providers/            # wagmi + RainbowKit + TanStack Query
│
├── packages/
│   ├── ai-agents/                # Claude-powered execution agents ★
│   │   ├── src/agents/           # TWAP, Momentum, Shadow, Arbitrage
│   │   ├── src/prompts/          # System + user prompt templates
│   │   ├── src/tools/            # Price feed, slippage, history, chain tools
│   │   └── src/orchestrator/     # Competition + scoring orchestrators
│   ├── ui/                       # Internal design system
│   ├── types/                    # Shared TypeScript types
│   ├── config/                   # Env schemas, chain configs, addresses
│   ├── sdk/                      # IntentClient + typed WebSocket client
│   ├── agents-shared/            # Agent interfaces + strategy types
│   ├── api-client/               # Generated OpenAPI client
│   ├── eslint-config/            # Shared ESLint configs
│   └── tsconfig/                 # Shared tsconfig bases
│
├── services/
│   ├── competition-engine/       # Competition lifecycle + scoring
│   ├── reputation-engine/        # ELO-inspired reputation calculator
│   ├── execution-validator/      # Validates on-chain execution proofs
│   ├── settlement-engine/        # USDC settlement coordination
│   └── agent-orchestrator/       # Agent process management
│
├── backend/
│   ├── cmd/api/                  # Entry point (Gin, graceful shutdown)
│   ├── internal/
│   │   ├── domain/               # Pure domain types + interfaces
│   │   ├── services/             # Business logic + HTTP handlers
│   │   ├── realtime/             # WebSocket hub + Redis broadcaster
│   │   ├── indexer/              # Arc L1 chain event listener
│   │   └── infra/                # PostgreSQL, Redis, chain clients
│   └── db/
│       ├── migrations/           # SQL migrations (golang-migrate)
│       └── queries/              # SQLC query files
│
├── contracts/
│   ├── src/core/                 # IntentEscrow, ReputationRegistry, AgentRegistry...
│   ├── src/interfaces/           # Contract interfaces
│   ├── src/mocks/                # MockUSDC for testing
│   ├── test/                     # Foundry tests + fuzz tests
│   └── script/                   # Deployment scripts
│
├── infrastructure/
│   ├── postgres/                 # Schema
│   ├── grafana/                  # Dashboards + datasources
│   └── monitoring/               # Prometheus config
│
├── tooling/
│   ├── docker/docker-compose.yml # Full local stack
│   └── scripts/setup.sh          # One-command setup
│
└── docs/ARCHITECTURE.md          # Full system design reference
```

---

## Tech Stack

| Layer          | Technology                                                   |
| -------------- | ------------------------------------------------------------ |
| **Frontend**   | Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui |
| **Animations** | Framer Motion, GSAP, Lenis (smooth scroll)                   |
| **Web3**       | wagmi v2, viem, RainbowKit                                   |
| **State**      | Zustand, TanStack Query v5                                   |
| **Backend**    | Go 1.25, Gin, gorilla/websocket                              |
| **Database**   | PostgreSQL 16, Redis 7, SQLC                                 |
| **AI Agents**  | Anthropic Claude (`claude-sonnet-4-6`) with tool-use         |
| **Contracts**  | Solidity 0.8.24, Foundry, OpenZeppelin 5.x                   |
| **Infra**      | Docker Compose, Prometheus, Grafana, Jaeger (OTel)           |
| **Monorepo**   | pnpm workspaces, Turborepo                                   |
| **Chain**      | Arc L1                                                       |

---

## Quick Start

**Prerequisites:** Node 22, pnpm 9, Go 1.25+, Docker, Foundry (for contracts)

```bash
# Clone
git clone https://github.com/Cookit-labs/Intent.git
cd Intent

# One-command setup (installs deps, copies .env files, starts infra)
make setup

# Fill in API keys
nano .env   # set ANTHROPIC_API_KEY, ARC_RPC_URL, etc.

# Start everything
make dev
```

| Service    | URL                          |
| ---------- | ---------------------------- |
| Website    | http://localhost:3000        |
| dApp       | http://localhost:3001        |
| API        | http://localhost:8080        |
| API Health | http://localhost:8080/health |
| Grafana    | http://localhost:3003        |
| Jaeger     | http://localhost:16686       |

---

## Common Commands

```bash
# Development
make dev              # Start all apps (turbo dev)
make backend-dev      # Start Go API only
make docker-up        # Start infrastructure (postgres, redis, etc.)
make docker-down      # Stop infrastructure

# Building
make build            # Build all packages and apps
make contracts        # Compile Solidity contracts

# Testing
make test             # Run all tests (TS + Go + Foundry)
make contracts-test   # Run Foundry tests with fuzz (1000 runs)

# Database
make migrate          # Apply SQL migrations
make generate         # Run SQLC codegen

# Code quality
pnpm typecheck        # TypeScript type checking across all packages
pnpm lint             # ESLint across all packages
pnpm format           # Prettier format
```

---

## Smart Contracts

| Contract             | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `IntentEscrow`       | Holds USDC during competition; releases to winning agent |
| `ReputationRegistry` | On-chain agent reputation scores and history             |
| `AgentRegistry`      | Agent registration, capability flags, stake requirements |
| `SettlementManager`  | Coordinates USDC settlement (protocol fee: 0.1%)         |
| `ExecutionValidator` | Validates execution proofs submitted by agents           |

```bash
# Deploy to Arc testnet
cd contracts
forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast --verify
```

---

## AI Agent Design

Each agent is a Claude instance with access to on-chain tools:

```typescript
// Tool-use pattern — agents call real functions inside their reasoning loop
const tools = [
  priceFeedTool, // get_price(tokenIn, tokenOut)
  slippageTool, // estimate_slippage(tokenIn, tokenOut, amountIn)
  historyTool, // get_agent_history(agentId)
  chainTool, // read_chain_state(contract, method, args)
]

// Competition flow
const proposals = await Promise.allSettled([
  twapAgent.propose(intent, competitionId),
  momentumAgent.propose(intent, competitionId),
  shadowAgent.propose(intent, competitionId),
  arbAgent.propose(intent, competitionId),
])

// Claude scores all proposals and selects winner
const ranked = await scoringOrchestrator.rankProposals(proposals, intent)
```

### Reputation Scoring

```
Win:  delta = base_points × execution_quality_factor   (+5 to +50)
Loss: delta = -base_points × margin_factor             (-2 to -20)
Decay: -0.5% per day of inactivity
Slash: on-chain, governance-determined amount
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable                               | Required     | Description                  |
| -------------------------------------- | ------------ | ---------------------------- |
| `ANTHROPIC_API_KEY`                    | **Yes**      | Claude API key (AI agents)   |
| `DATABASE_URL`                         | **Yes**      | PostgreSQL connection string |
| `REDIS_URL`                            | **Yes**      | Redis connection string      |
| `JWT_SECRET`                           | **Yes**      | Minimum 32 characters        |
| `ARC_RPC_URL`                          | For on-chain | Arc L1 RPC endpoint          |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | For dApp     | WalletConnect v2             |

---

## Documentation

- **[Architecture Reference](docs/ARCHITECTURE.md)** — System design, ADRs, database schema, WebSocket protocol, agent design, deployment guide

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit using conventional commits: `feat:`, `fix:`, `chore:`, etc.
4. Open a PR — CI runs typecheck, Go build, and Foundry tests automatically

---

<div align="center">

Built by [Cookit Labs](https://github.com/Cookit-labs) · Arc L1 Agentic Hackathon

</div>
