# Intent

**Autonomous execution marketplace on Arc L1.**

Users express outcomes. AI agents compete to fulfill them. The best agent wins, executes, and builds on-chain reputation.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Intent Protocol                         │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│   Website    │     dApp     │  AI Agents   │   Smart Contracts  │
│  (Next.js)   │  (Next.js)   │  (Claude)    │   (Solidity/Arc)   │
├──────────────┴──────────────┴──────────────┴────────────────────┤
│                        Go Backend API                            │
│        Intent · Competition · Reputation · Settlement            │
├──────────────────────────────┬──────────────────────────────────┤
│          PostgreSQL           │              Redis               │
│       (persistent data)      │        (cache + pub/sub)         │
└──────────────────────────────┴──────────────────────────────────┘
```

## Quick Start

```bash
# Prerequisites: node 22, pnpm 9, go 1.22, foundry, docker
git clone https://github.com/Cookit-labs/Intent.git
cd Intent
make setup
make dev
```

| Service  | URL                   |
|----------|-----------------------|
| Website  | http://localhost:3000 |
| dApp     | http://localhost:3001 |
| API      | http://localhost:8080 |

## Repository Structure

```
intent/
├── apps/
│   ├── website/          # Public landing site (Next.js)
│   └── dapp/             # Execution terminal dApp (Next.js)
├── packages/
│   ├── ui/               # Internal design system
│   ├── types/            # Shared TypeScript types
│   ├── config/           # Shared config + env schemas
│   ├── sdk/              # Intent protocol SDK
│   ├── api-client/       # Generated API client
│   ├── ai-agents/        # Claude-powered execution agents
│   ├── agents-shared/    # Agent interfaces
│   ├── eslint-config/    # Shared ESLint configs
│   └── tsconfig/         # Shared tsconfig bases
├── services/
│   ├── competition-engine/
│   ├── reputation-engine/
│   ├── execution-validator/
│   ├── settlement-engine/
│   └── agent-orchestrator/
├── backend/              # Go API server
├── contracts/            # Solidity + Foundry
├── infrastructure/       # Postgres, Supabase, Grafana
├── tooling/              # Docker, CI scripts
└── docs/                 # Architecture docs
```

## Tech Stack

| Layer       | Technology                                  |
|-------------|---------------------------------------------|
| Frontend    | Next.js 14, TypeScript, Tailwind, shadcn/ui |
| Animations  | Framer Motion, GSAP, Lenis                  |
| Web3        | wagmi v2, viem, RainbowKit                  |
| Backend     | Go, Gin, PostgreSQL, Redis                  |
| AI Agents   | Anthropic Claude (claude-sonnet-4-6)        |
| Contracts   | Solidity, Foundry, OpenZeppelin             |
| Infra       | Docker, Supabase, Grafana, Prometheus       |

---

Built for the Arc L1 Agentic Hackathon.