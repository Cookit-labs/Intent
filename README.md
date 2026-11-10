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

## NEAR Hackathon

Built at NEAR HACKATHON. **Only the NEAR integration below was built in the hackathon window and is
submitted for judging.**

**Disclosure.** Intent existed before the hackathon as a chat app for trading on Stellar. That
product, including its chat, agent race and interface, is baseline. The sections after this one
describe the wider project, and some predate the current app.

- Baseline: tag `pre-hackathon`
- Submitted: tag `hackathon-submission`
- Diff: [`pre-hackathon...hackathon-submission`](https://github.com/Cookit-labs/Intent/compare/pre-hackathon...hackathon-submission)

That diff also carries work on other chains. The NEAR work is in
[`apps/dapp/lib/chains/near/`](apps/dapp/lib/chains/near),
[`apps/dapp/lib/wallet/near-connector.ts`](apps/dapp/lib/wallet/near-connector.ts) and the
`near-*` and `rhea*` files in [`apps/dapp/lib/__tests__/`](apps/dapp/lib/__tests__). A full
file map and the scope for reviewers is in [`AGENTS.md`](AGENTS.md).

### The problem and the product

Using DeFi on NEAR means knowing which app to open, comparing prices yourself and working through
wrapping, storage deposits and receipts that can fail after a transaction reports success. In
Intent you type what you want in a chat. AI agents compare real quotes, question each other's
choices in the chat and propose a route. You read a card and sign in your own wallet. Agents can't
sign or send anything.

### What runs on NEAR

| You type                                 | What happens                                                              | Built on                      |
| ---------------------------------------- | ------------------------------------------------------------------------- | ----------------------------- |
| `swap 5 USDC to NEAR`                    | Agents race live quotes, you sign the winner                              | Rhea DEX, NEAR Intents 1Click |
| `swap 5 USDC to NEAR then stake`         | Swap, then stake what arrived, as two steps                               | Rhea DEX, Meta Pool           |
| `stake 1 NEAR with Meta Pool`            | Stake, and later unstake and claim                                        | Meta Pool, rNEAR              |
| `supply 25 USDC on 1Click Earn`          | Deposit and withdraw                                                      | NEAR Intents                  |
| `supply 25 USDC on Rhea Lend`            | Supply, withdraw, borrow, repay                                           | Rhea Lend                     |
| `send 1 NEAR to bob.near`                | A plain NEAR transfer                                                     | Protocol `Transfer` action    |
| `send 5 USDC to <Solana or Sui address>` | Pays out on that chain, refund comes back to NEAR                         | NEAR Intents 1Click           |
| a limit order on NEAR and USDC           | Rests in the pool until filled or cancelled                               | Rhea DCL                      |
| `where is my money`                      | Every position, what to type next, and how far a loan is from liquidation | Contract reads                |

**NEAR technology used:** NEAR Intents 1Click API, NEP-141 tokens, NEAR Connect
(`@hot-labs/near-connect`) and, for one of the competing agents, NEAR AI Cloud. That agent runs
GLM 5.3 Flash, which NEAR's model catalogue lists as verifiable and attested. Intent doesn't check
the attestation itself.

**Libraries and tools:** see `apps/dapp/package.json`. Much of the code was written with AI coding
tools. The Stellar app and its shared chat code are this team's own pre-hackathon work.

### Try it with no wallet and no funds

These read real NEAR mainnet and 1Click. They sign nothing and need no keys.

```bash
pnpm install
cd apps/dapp
pnpm exec vitest run lib/__tests__/near-1click.live.test.ts lib/__tests__/rhea.live.test.ts lib/__tests__/near-contracts.live.test.ts lib/__tests__/near-exits.live.test.ts lib/__tests__/near-rhea-dcl.live.test.ts
```

You should see every test pass. They cover real dry quotes, Rhea pool and lending reads, and
transactions built and checked but never sent.

### Try it in the app

Everything here runs on mainnet, so use small amounts. The app is at
[app.runintent.xyz](https://app.runintent.xyz) and needs a NEAR wallet.

1. Open the app and connect a NEAR wallet. You should land in the chat on NEAR.
2. Type `swap 1 USDC to NEAR`. You should see agents post proposals and question each other, then a
   swap card with the amount you'd receive. Your wallet asks you to sign only when you confirm.
3. Type `where is my money`. You should see what you hold in each app and what to type next.

To run it locally, follow [Quick Start](#quick-start), then set one model key in
`apps/dapp/.env.local`. `GROQ_API_KEY` is free and enough for one agent.

### Not done or not proven

- **Real wallet runs:** the NEAR flows are covered by tests and live read-only checks. No transaction
  through this app has yet been confirmed on NEAR by a real wallet.
- **Cash-out to a bank:** closed from NEAR, because the payout provider can't open an order for a
  NEAR deposit yet. Sending USDC to Solana and cashing out there is the way around it.
- **Sends to EVM chains:** refused, because a 0x address doesn't say which chain it means.
- **Swaps into NEAR through 1Click:** these arrive as wNEAR, so 1Click only runs for them when it's
  named. A stake or send after one stops and says the swap went through.

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

| Repo                                                                              | What it contains                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------- |
| **[Intent (this repo)](https://github.com/Cookit-labs/Intent)**                   | Next.js website + dApp frontend                    |
| **[Backend](https://github.com/Cookit-labs/Backend)**                             | Go API, competition engine, reputation, settlement |
| **[intent-core-contracts](https://github.com/Cookit-labs/intent-core-contracts)** | Solidity contracts on Arc L1                       |

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

| Layer          | Technology                                                   |
| -------------- | ------------------------------------------------------------ |
| **Frontend**   | Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui |
| **Animations** | Framer Motion, GSAP, Lenis (smooth scroll)                   |
| **Web3**       | wagmi v2, viem, RainbowKit                                   |
| **State**      | Zustand, TanStack Query v5                                   |
| **Monorepo**   | pnpm workspaces, Turborepo                                   |
| **Chain**      | Arc L1                                                       |

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

| App     | URL                    |
| ------- | ---------------------- |
| Website | http://localhost:3000  |
| dApp    | https://localhost:3001 |

The dApp's dev server runs over HTTPS with a local certificate, because Varial
refuses to sign for a site without one. The first run downloads `mkcert` and
Windows asks to trust its root certificate (`mkcert -uninstall` removes it). The
dApp needs Postgres and Redis for sessions, limits and the sponsor ledger, so
start Docker first: `docker compose up -d`.

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
make test         # Run tests (SKIP_LIVE=1 make test skips the ones that reach testnet)
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

## Access Gate

On for mainnet pages, off for testnet; `ACCESS_GATE=on|off` overrides it. Only
emails marked `accepted` receive a login code. Accept one at `/admin/waitlist`
with `ADMIN_TOKEN`, including an address that has not signed up. Without
`RESEND_API_KEY` the code prints in the dApp's server console instead of being
emailed.

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

| Route             | Purpose                 |
| ----------------- | ----------------------- |
| `/verify`         | Email + OTP sign-in     |
| `/waitlist`       | Public signup           |
| `/admin/waitlist` | Accept / revoke testers |

Codes are stored hashed with a 10-minute TTL, die after 5 wrong attempts, and are
rate-limited to 1/minute and 5/hour per address.

---

## AI Agents

An agent is a model. Each one competes on the same live quotes, so different models really do
disagree. Set any of these keys and that model joins the race, on every chain:

| Variable             | Model                           |
| -------------------- | ------------------------------- |
| `ANTHROPIC_API_KEY`  | Claude Sonnet                   |
| `DEEPSEEK_API_KEY`   | DeepSeek V4 Flash               |
| `GROQ_API_KEY`       | Qwen on Groq's free plan        |
| `NEARAI_API_KEY`     | GLM 5.3 Flash on NEAR AI Cloud  |
| `OPENROUTER_API_KEY` | Three free models on OpenRouter |

`AGENT_BRAINS` overrides the line-up, for example `AGENT_BRAINS=nearai,groq`.

**The keys are server-side only.** Agents run in a route handler (`app/api/agents/compete`) that
streams each proposal as it lands. Nothing under `lib/agents/brains/` may be imported from a
component.

**There is no fallback.** With no key, or when nobody answers, the chat says the agents aren't
available. It never shows a made-up proposal.

**Scoring is deterministic TypeScript**, not a model call, so identical runs score identically.

**Outside text can't steer a model.** Text from outside reaches the models on every chain. That
includes:

- A token's own name, and anyone can airdrop a token into a wallet.
- Venue and route labels.
- Earlier replies and other agents' words.
- Text pasted from a web page.

All of it passes `lib/agents/prompt-safe.ts` first. That file:

- Removes characters nobody can see (zero-width characters, direction overrides, Unicode tag
  characters, private-use characters).
- Folds full-width lookalike letters to plain ones.
- Strips chat template markers.
- Keeps each value to one bounded line, and defuses lines that pose as a new turn.

A token symbol keeps only symbol characters, and is flagged when it uses non-Latin letters, like a
Cyrillic "USDС". Every system prompt says outside text is data, not instructions. None of this is
the last line of defence: every proposal is checked by deterministic code, every transaction is
checked by its chain's safety rules, and the person signs.

`prompt-injection.test.ts` runs 11 attacks against each prompt on all six chains.
`prompt-injection.live.test.ts` sends a scam-token order and a hidden pasted order to the real
chat model.

---

<div align="center">

Part of the **[Cookit Labs](https://github.com/Cookit-labs)** ecosystem — building the execution layer for the agentic web.

</div>
