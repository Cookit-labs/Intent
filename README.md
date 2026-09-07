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
[![Next.js](https://img.shields.io/badge/Frontend-Next.js_14-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![Claude](https://img.shields.io/badge/AI-Claude_Sonnet-D97757?style=flat-square)](https://anthropic.com)
[![Arc L1](https://img.shields.io/badge/Chain-Arc_L1-6366f1?style=flat-square)]()

<br />

</div>

---

## What is Intent?

Intent is a stablecoin-native execution marketplace. Instead of placing orders manually, users express the **outcome** they want — buy ETH, accumulate a position, hedge exposure, rebalance capital. Autonomous AI agents then compete in a timed auction to fulfill that intent.

The best-performing agent wins execution rights, executes the trade using constrained on-chain permissions, and gets its reputation updated on Arc L1.

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

## This Repository

This is the **frontend monorepo** — the public website and the execution dApp. It is one part of three:

| Repo | What it contains |
|------|-----------------|
| **[Intent (this repo)](https://github.com/Cookit-labs/Intent)** | Next.js website + dApp frontend |
| **[Backend](https://github.com/Cookit-labs/Backend)** | Go API, competition engine, reputation, settlement |
| **[intent-core-contracts](https://github.com/Cookit-labs/intent-core-contracts)** | Solidity contracts on Arc L1 |

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
└── packages/
    ├── ui/                       # Internal design system
    ├── types/                    # Shared TypeScript types
    ├── config/                   # Env schemas, chain configs, addresses
    ├── sdk/                      # IntentClient + typed WebSocket client
    ├── api-client/               # Generated OpenAPI client
    ├── eslint-config/            # Shared ESLint configs
    └── tsconfig/                 # Shared tsconfig bases
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui |
| **Animations** | Framer Motion, GSAP, Lenis (smooth scroll) |
| **Web3** | wagmi v2, viem, RainbowKit |
| **State** | Zustand, TanStack Query v5 |
| **Monorepo** | pnpm workspaces, Turborepo |
| **Chain** | Arc L1 |

---

## Quick Start

**Prerequisites:** Node 22, pnpm 9

```bash
# Clone
git clone https://github.com/Cookit-labs/Intent.git
cd Intent

# Install dependencies and copy env files
make setup

# Start both apps
make dev
```

| App | URL |
|-----|-----|
| Website | http://localhost:3000 |
| dApp | http://localhost:3001 |

---

## Apps

### `apps/website`

Public landing site. Explains the protocol, showcases the agent competition model, and links to the dApp.

**Key sections:**
- Hero with protocol visualization
- How agents compete
- Live leaderboard preview
- Links to the execution terminal

### `apps/dapp`

The execution terminal. Connect your wallet, submit intents, and watch AI agents compete to fulfill them in real-time.

**Routes:**
- `/` — dashboard
- `/intents` — submit & manage intents
- `/competitions` — active competition feed
- `/leaderboard` — agent reputation rankings
- `/agents` — agent detail pages
- `/analytics` — execution performance charts
- `/history` — past executions
- `/vault` — USDC deposit/withdrawal
- `/settings` — user preferences

---

## Common Commands

```bash
make dev          # Start website + dApp
make build        # Build all packages and apps
make typecheck    # TypeScript type checking
make lint         # ESLint across all packages
make test         # Run tests
make format       # Prettier format
make clean        # Clean build artifacts
```

---

## Environment Variables

```bash
# apps/website/.env.local
NEXT_PUBLIC_API_URL=http://localhost:8080

# apps/dapp/.env.local
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id
NEXT_PUBLIC_API_URL=http://localhost:8080
```

Copy `.env.example` files to get started:

```bash
cp apps/website/.env.example apps/website/.env.local
cp apps/dapp/.env.example apps/dapp/.env.local
```

---

## Access Gate (built, currently DISABLED)

> Not active. This was built from a prompt intended for a different project,
> so **nothing in the dApp is gated** — all routes are open. The code is kept
> in case it is wanted later; re-enable by restoring the matcher in
> `apps/dapp/middleware.ts`.

When enabled, only emails marked `accepted` receive a login code.

```bash
docker compose up -d          # Postgres :55432, Redis :56379 (non-default: other
                              # local projects commonly hold 5432/6379)
cp apps/dapp/.env.example apps/dapp/.env.local   # then fill AUTH_SECRET + ADMIN_TOKEN
pnpm dev
```

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # ADMIN_TOKEN
```

**Flow.** `/verify` asks for an email. Accepted -> a 6-digit code is emailed and a
signed httpOnly cookie is set on success. Not accepted -> routed to `/waitlist`.
Everything under `/[chain]/*` is blocked by middleware until that cookie exists.

**In development no email is sent** — the code prints to the dev-server console.
Set `RESEND_API_KEY` and `EMAIL_FROM` to send real mail.

**Accepting someone:** open `/admin/waitlist`, enter `ADMIN_TOKEN`, click Accept.

| Route | Purpose |
|-------|---------|
| `/verify` | Email + OTP sign-in |
| `/waitlist` | Public signup |
| `/admin/waitlist` | Accept / revoke testers |

Codes are stored hashed with a 10-minute TTL, die after 5 wrong attempts, and are
rate-limited to 1/minute and 5/hour per address.

---

## AI Agents

The four competing agents (TWAP, Momentum, Arbitrage, Shadow) reason with
DeepSeek. Off by default — with no configuration the app runs a simulated race
and behaves exactly as before.

```bash
# apps/dapp/.env.local
AGENT_BRAIN=deepseek
DEEPSEEK_API_KEY=sk-...
NEXT_PUBLIC_USE_AI=true
```

**The key is server-side only.** Agents run in a route handler
(`app/api/agents/compete`) that streams each proposal over SSE as it lands.
Nothing under `lib/agents/brains/` may be imported from a component.

**Failure degrades, it does not break.** A missing key, a rate limit, a timeout
or a malformed response makes that one agent fall back to a simulated proposal;
the race still renders four cards and picks a winner. The panel says
"Simulated proposals" whenever any card came from the fallback, so mock
reasoning is never passed off as live agent output.

**Scoring is deterministic TypeScript**, not a model call — a model grading its
own competition would not be reproducible between identical runs.

**Swapping provider** means adding one file under `lib/agents/brains/` and a
line in `registry.ts`. Nothing else knows which model answered.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_BRAIN` | `mock` | `deepseek` to use the model |
| `DEEPSEEK_API_KEY` | — | Unset falls back to simulated agents |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | `deepseek-v4-pro` for harder reasoning |
| `NEXT_PUBLIC_USE_AI` | `false` | Routes the UI through the agent endpoint |

---

<div align="center">

Part of the **[Cookit Labs](https://github.com/Cookit-labs)** ecosystem — building the execution layer for the agentic web.

</div>
