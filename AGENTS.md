# Reviewing Intent for the NEAR Hackathon

This repository is a multichain monorepo. Only the NEAR integration is submitted for judging. The
Stellar, Solana, Sui, Avalanche and Monad code, the website in `apps/website` and the shared
packages in `packages/` existed before the hackathon or were built for other chains, and are out of
scope. Sui and Solana count only as destinations of a NEAR cross-chain send.

## What changed in the hackathon window

- Baseline: tag `pre-hackathon` (`940b6fb`, 17 Oct 2026, the last commit before the 19 Oct
  announcement). It contains no NEAR code.
- First NEAR commit: `326753f`, 4 Nov 2026. The NEAR side was built between 4 and 14 November;
  the README's "When the NEAR work was built" table lists the pull requests by date.
- Submission: tag `hackathon-submission`.
- NEAR-only diff:

```bash
git diff pre-hackathon hackathon-submission -- apps/dapp/lib/chains/near apps/dapp/lib/wallet/near-connector.ts apps/dapp/lib/weave/deposit/near.ts apps/dapp/lib/agents/brains/nearai-proof.ts
```

## Where the NEAR code is

| Path                                                           | What it does                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/dapp/lib/chains/near/module.ts`                          | The NEAR chain module: venues, quotes and transaction building for the chat    |
| `apps/dapp/lib/chains/near/oneclick.ts`, `quote-signature.ts`  | NEAR Intents 1Click quotes, deposit addresses and quote signature checks       |
| `apps/dapp/lib/chains/near/cross-chain.ts`                     | USDC sends from NEAR to Solana or Sui through 1Click                           |
| `apps/dapp/lib/chains/near/rhea-*.ts`                          | Rhea DEX swaps, Rhea Lend supply, borrow and repay, Rhea DCL limit orders      |
| `apps/dapp/lib/chains/near/stake.ts`, `earn.ts`                | Meta Pool, rNEAR and LiNEAR staking, unstaking and claims, 1Click Earn         |
| `apps/dapp/lib/weave/deposit/near.ts`                          | The deposit for an off-ramp from NEAR to a bank, checked against the order     |
| `apps/dapp/lib/chains/near/safety.ts`, `rhea-safety.ts`        | Server-side checks on every NEAR transaction before the wallet signs           |
| `apps/dapp/lib/chains/near/rpc.ts`, `balances.ts`, `tokens.ts` | RPC with failover, spendable balances, NEP-141 tokens                          |
| `apps/dapp/lib/wallet/near-connector.ts`                       | Wallet connection through NEAR Connect (`@hot-labs/near-connect`)              |
| `apps/dapp/lib/agents/brains/providers.ts` (`nearai`)          | NEAR AI Cloud as one of the competing agents                                   |
| `apps/dapp/lib/agents/brains/nearai-proof.ts`                  | Checks each NEAR AI answer against Intel TDX, NVIDIA and the reply signature   |
| `apps/dapp/lib/chains/registry.ts`                             | Where the NEAR module is registered with the shared chat                       |
| `apps/dapp/lib/__tests__/near-*.test.ts`, `rhea*.test.ts`      | Unit tests, and `*.live.test.ts` checks against NEAR mainnet that sign nothing |

The chat, agent race and cards in `apps/dapp/components/` are shared with every chain and predate
the hackathon. Some shared code was also changed in the window and applies to NEAR along with the
other chains: the prompt-injection guard (`apps/dapp/lib/agents/prompt-safe.ts`), the check that an
amount, token and recipient come from the person's own words (`apps/dapp/lib/chains/parse-sequence.ts`),
and the off-ramp order sizing (`apps/dapp/lib/weave/orders.ts`).

## What has run on mainnet

The README's "Proven on NEAR mainnet with a real wallet" table links each transaction on NearBlocks:
an rNEAR stake and unstake, two Rhea DEX swaps, and two off-ramps from NEAR that paid naira to a bank
account. Everything else is covered by the tests below and is listed under "Not done or not proven".

## How to check it runs

No wallet, funds or API keys are needed. From the repository root:

```bash
pnpm install
cd apps/dapp
pnpm exec vitest run lib/__tests__/near-1click.live.test.ts lib/__tests__/rhea.live.test.ts lib/__tests__/near-contracts.live.test.ts lib/__tests__/near-exits.live.test.ts lib/__tests__/near-rhea-dcl.live.test.ts
```

These read NEAR mainnet and 1Click and take about 90 seconds. Every NEAR test file runs with
`pnpm exec vitest run near- rhea weave-deposit-near`. `near-ai.live.test.ts` needs NEAR AI Cloud's
public model list to answer, and its calls that use credits, the signed reply check among them,
run only with `NEARAI_API_KEY` set. `near-ai-proof.test.ts` covers every way the check fails closed,
with no network.

See the [NEAR Hackathon section of the README](README.md#near-hackathon) for the product, what
each chat command does, and what is not done or not proven.
