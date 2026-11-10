# Reviewing Intent for the NEAR Hackathon

This repository is a multichain monorepo. Only the NEAR integration is submitted for judging. The
Stellar, Solana, Sui, Avalanche and Monad code, the website in `apps/website` and the shared
packages in `packages/` existed before the hackathon or were built for other chains, and are out of
scope. Sui and Solana count only as destinations of a NEAR cross-chain send.

## What changed in the hackathon window

- Baseline: tag `pre-hackathon` (`940b6fb`, 17 Oct 2026, the last commit before the 19 Oct
  announcement). It contains no NEAR code.
- Submission: tag `hackathon-submission`.
- NEAR-only diff:

```bash
git diff pre-hackathon hackathon-submission -- apps/dapp/lib/chains/near apps/dapp/lib/wallet/near-connector.ts apps/dapp/lib/weave/deposit/near.ts
```

## Where the NEAR code is

| Path                                                           | What it does                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/dapp/lib/chains/near/module.ts`                          | The NEAR chain module: venues, quotes and transaction building for the chat    |
| `apps/dapp/lib/chains/near/oneclick.ts`, `quote-signature.ts`  | NEAR Intents 1Click quotes, deposit addresses and quote signature checks       |
| `apps/dapp/lib/chains/near/cross-chain.ts`                     | USDC sends from NEAR to Solana or Sui through 1Click                           |
| `apps/dapp/lib/chains/near/rhea-*.ts`                          | Rhea DEX swaps, Rhea Lend supply, borrow and repay, Rhea DCL limit orders      |
| `apps/dapp/lib/chains/near/stake.ts`, `earn.ts`                | Meta Pool and rNEAR staking, 1Click Earn                                       |
| `apps/dapp/lib/chains/near/safety.ts`, `rhea-safety.ts`        | Server-side checks on every NEAR transaction before the wallet signs           |
| `apps/dapp/lib/chains/near/rpc.ts`, `balances.ts`, `tokens.ts` | RPC with failover, spendable balances, NEP-141 tokens                          |
| `apps/dapp/lib/wallet/near-connector.ts`                       | Wallet connection through NEAR Connect (`@hot-labs/near-connect`)              |
| `apps/dapp/lib/agents/brains/providers.ts` (`nearai`)          | NEAR AI Cloud as one of the competing agents                                   |
| `apps/dapp/lib/chains/registry.ts`                             | Where the NEAR module is registered with the shared chat                       |
| `apps/dapp/lib/__tests__/near-*.test.ts`, `rhea*.test.ts`      | Unit tests, and `*.live.test.ts` checks against NEAR mainnet that sign nothing |

The chat, agent race and cards in `apps/dapp/components/` are shared with every chain and predate
the hackathon.

## How to check it runs

No wallet, funds or API keys are needed. From the repository root:

```bash
pnpm install
cd apps/dapp
pnpm exec vitest run lib/__tests__/near-1click.live.test.ts lib/__tests__/rhea.live.test.ts lib/__tests__/near-contracts.live.test.ts lib/__tests__/near-exits.live.test.ts lib/__tests__/near-rhea-dcl.live.test.ts
```

These read NEAR mainnet and 1Click and take about 90 seconds. Every NEAR test file runs with
`pnpm exec vitest run near- rhea weave-deposit-near`. `near-ai.live.test.ts` needs NEAR AI Cloud's
public model list to answer.

See the [NEAR Hackathon section of the README](README.md#near-hackathon) for the product, what
each chat command does, and what is not done or not proven.
