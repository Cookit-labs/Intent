# Mainnet venues and hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every Stellar venue whose mainnet contracts are already verified (Aquarius, Soroswap Aggregator, Blend) on mainnet behind the existing flag, with the trade cap on every Blend route that moves value, and close the money-affecting "should change soon" items from the security review (M2, M3, M11).

**Architecture:** No new subsystem. Venue availability is the single `networks` field in `apps/dapp/lib/venues.ts`; everything else (agents, quotes, contract allowlist, builders) already derives from it. The cap is the existing `assertTradeWithinCap`, wrapped once for Blend reserves. M2, M3 and M11 are three small, independent guards.

**Tech Stack:** Next.js 14 route handlers, TypeScript, `@stellar/stellar-sdk` 17, vitest (node env, `SKIP_LIVE=1`).

**Spec:** `docs/security/2026-09-25-mainnet-readiness-review.md` (findings M1, M2, M3, M11 and the go/no-go list) and `docs/superpowers/plans/2026-09-24-mainnet-readiness.md` (the network flag, per-network registries, trade cap).

## Global Constraints

- Own branch per phase, off `main`: `feat/mainnet-venues` (Tasks 1-2), `feat/mainnet-hardening` (Tasks 3-5). Do not push; the user pushes.
- commitlint: header at most 100 chars, lowercase after the type. No co-author lines. No "Generated with Claude Code" footer in commits or PR bodies.
- Tests first and watched failing. Logic in `lib/`; routes thin. Vitest is node-only.
- Comments say why, in the voice of the existing code; no comments that restate the code.
- Before finishing a phase: `cd apps/dapp && SKIP_LIVE=1 npx vitest run`, `npx tsc --noEmit -p .`, `pnpm exec next lint`, `npx prettier --check` on touched files.
- Write files with the Write/Edit tools (backslashes are eaten in Bash heredocs). Bash cwd resets between calls: use absolute paths or `git -C`.
- A fresh worktree has no `node_modules`; this plan works in the main checkout on branches, so none is needed.
- `next build` fails on Windows at the `/icon` prerender; that is environmental, CI on Linux passes.

## Out of scope (and why)

- **M1** (`assertSelfSubmission` through `lookupContract`): after Task 1 every swap contract is on mainnet, so the inconsistency it describes can no longer occur. Revisit if a swap venue is ever testnet-only again.
- **M4** (sum a plan's cap across symbols): `trade-cap.test.ts` ("passes steps that spend different assets, each under the cap") pins the current per-symbol rule as intended. Changing it is a product decision, not a fix.
- **Etherfuse on mainnet:** `asset-registry.ts` holds only the sandbox issuer (`sand.etherfuse.com`). The mainnet issuer must be verified from Etherfuse's own mainnet `stellar.toml` first.
- **DeFindex:** needs `DEFINDEX_API_KEY` and a real signed deposit before `executes`.
- **Noether, MoneyGram production, NGN rail:** external dependencies or a separate plan.
- **M5, M6, M7, M8, M9, M10:** a second hardening plan.

## Review Focus

- A venue flagged for mainnet but whose contract id is `undefined` on mainnet must stay off the allowlist: pinned by the existing `lookupContract` filter, re-checked in Task 1 Step 6.
- Blend `borrow` with an asset that has no price (any non-XLM reserve) must be refused on mainnet, not waved through: Task 2 test "refuses a reserve it cannot price".
- `repay` and `collateral reclaim` with no amount ("everything") must still build: Task 2 keeps them uncapped, with the reason in a comment, and the test pins that `assertReserveWithinCap` is never called without an amount.
- A client sending `slippageBps` as a string, a float, a negative number or `Infinity` must get a 400, not a 500 from `applySlippage`: Task 4 tests.
- A sponsor-eligible Soroban transaction must still be bumped at its real resource fee (hundreds of thousands of stroops) after the classic cap drops: Task 5 test.

---

## Phase B: venues (branch `feat/mainnet-venues`)

Run once before Task 1:

```bash
git -C /c/Users/owner/Projects/Intent-restore switch -c feat/mainnet-venues main
```

### Task 1: Flag Aquarius, the Soroswap Aggregator and Blend for mainnet

**Files:**

- Modify: `apps/dapp/lib/venues.ts` (three entries)
- Modify: `apps/dapp/lib/__tests__/venue-networks.test.ts`
- Modify: `apps/dapp/.env.example:23-26`
- Modify: any other test the full run shows encoding the old flags (Step 5)

**Interfaces:**

- Consumes: `Venue.networks?: StellarNetworkName[]` (already in `@intent/types`), `isVenueOn`, `venuesOn`, `assertVenueOn`.
- Produces: `venuesOn('mainnet')` now contains `aquarius`, `soroswap-aggregator`, `blend` in addition to `soroswap`, `stellarx`, `stellar-pools`, `sorobandomains`.

- [ ] **Step 1: Update the tests to the new expectation (failing first)**

In `apps/dapp/lib/__tests__/venue-networks.test.ts`:

Replace the `describe('which venues are on mainnet at launch', ...)` block's first test and the two that name Aquarius/Blend:

```ts
describe('which venues are on mainnet at launch', () => {
  it('is every venue whose mainnet contracts are verified in the code', () => {
    const ids = venuesOn('mainnet')
      .filter((v) => v.family === 'stellar')
      .map((v) => v.id)
      .sort()
    expect(ids).toEqual(
      [
        'aquarius',
        'blend',
        'sorobandomains',
        'soroswap',
        'soroswap-aggregator',
        'stellar-pools',
        'stellarx',
      ].sort()
    )
  })

  it('keeps every Stellar venue on testnet', () => {
    for (const v of stellar) {
      expect(isVenueOn(v, 'testnet'), `${v.id} should be on testnet`).toBe(true)
    }
  })

  it('treats an absent networks field as testnet only', () => {
    expect(isVenueOn({}, 'testnet')).toBe(true)
    expect(isVenueOn({}, 'mainnet')).toBe(false)
    expect(isVenueOn(byId('etherfuse')!, 'mainnet')).toBe(false)
    expect(isVenueOn(byId('noether')!, 'mainnet')).toBe(false)
    expect(isVenueOn(byId('defindex')!, 'mainnet')).toBe(false)
  })

  it('labels a Stellar venue that is not on mainnet, and only there', () => {
    expect(notOnNetworkLabel(byId('etherfuse')!, 'mainnet')).toBe('Not on mainnet yet')
    expect(notOnNetworkLabel(byId('soroswap')!, 'mainnet')).toBeUndefined()
    expect(notOnNetworkLabel(byId('etherfuse')!, 'testnet')).toBeUndefined()
    // An EVM venue is on another chain entirely; the Stellar flag says
    // nothing about it.
    expect(notOnNetworkLabel(byId('uniswap')!, 'mainnet')).toBeUndefined()
  })
})
```

Replace the `describe('what the agents are offered', ...)` mainnet tests:

```ts
it('lists only the mainnet venues on mainnet', () => {
  const ids = buildMarketContext('stellar', {}, 'mainnet')
    .venues.map((v) => v.id)
    .sort()
  expect(ids).toEqual([
    'aquarius',
    'blend',
    'soroswap',
    'soroswap-aggregator',
    'stellar-pools',
    'stellarx',
  ])
})
```

```ts
it('offers Blend on mainnet, and DeFindex only on testnet', () => {
  expect(configuredLendingVenues({ DEFINDEX_API_KEY: 'sk' }, 'mainnet')).toEqual(['blend'])
  expect(configuredLendingVenues({ DEFINDEX_API_KEY: 'sk' }, 'testnet')).toEqual([
    'blend',
    'defindex',
  ])
})
```

Replace the `describe('nothing is built against a venue that is not here', ...)` block:

```ts
describe('nothing is built against a venue that is not here', () => {
  it('passes for a venue on the network and refuses one that is not, by name', () => {
    expect(() => assertVenueOn('soroswap', 'mainnet')).not.toThrow()
    expect(() => assertVenueOn('aquarius', 'mainnet')).not.toThrow()
    expect(() => assertVenueOn('blend', 'mainnet')).not.toThrow()
    expect(() => assertVenueOn('aquarius', 'testnet')).not.toThrow()
    expect(() => assertVenueOn('etherfuse', 'mainnet')).toThrow('Etherfuse is not on mainnet yet')
    expect(() => assertVenueOn('noether', 'mainnet')).toThrow('Noether is not on mainnet yet')
    expect(() => assertVenueOn('defindex', 'mainnet')).toThrow('DeFindex is not on mainnet yet')
    // An id nobody listed is not a venue at all, and is refused the same way.
    expect(() => assertVenueOn('phoenix', 'testnet')).toThrow('phoenix is not on testnet yet')
  })
})
```

Remove the now-unused `import { buildAquariusSwap } from '../swap/build-aquarius'` line.

Replace the mainnet quote-source test:

```ts
it('asks every source whose venue is on mainnet', async () => {
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
  const asked: string[] = []
  const { quotes, failures } = await collectQuotes(
    [
      source('horizon', asked),
      source('aquarius', asked),
      source('soroswap', asked),
      source('soroswap-aggregator', asked),
    ],
    req
  )
  expect(asked.sort()).toEqual(['aquarius', 'horizon', 'soroswap', 'soroswap-aggregator'])
  expect(quotes).toEqual([])
  expect(failures.map((f) => f.source).sort()).toEqual([
    'aquarius',
    'horizon',
    'soroswap',
    'soroswap-aggregator',
  ])
})
```

In `describe('what the Apps page may call available, decided on the server', ...)`, change `expect(bare.has('aquarius')).toBe(false)` to:

```ts
expect(bare.has('aquarius')).toBe(true)
expect(bare.has('etherfuse')).toBe(false)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/owner/Projects/Intent-restore/apps/dapp && SKIP_LIVE=1 npx vitest run lib/__tests__/venue-networks.test.ts`
Expected: FAIL (mainnet venue list lacks `aquarius`, `blend`, `soroswap-aggregator`).

- [ ] **Step 3: Flag the three venues**

In `apps/dapp/lib/venues.ts`, add `networks: ['testnet', 'mainnet'],` directly after `integration: 'executes',` in the `soroswap-aggregator`, `aquarius` and `blend` entries. Each becomes, for example:

```ts
    id: 'aquarius',
    name: 'Aquarius',
    family: 'stellar' as const,
    category: 'swap',
    chains: ['Stellar'],
    bestFor: 'Incentivised AMM pools',
    url: 'https://aqua.network',
    integration: 'executes',
    networks: ['testnet', 'mainnet'],
```

(`soroswap-aggregator` and `blend` the same way; leave their `capability` text as is.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/owner/Projects/Intent-restore/apps/dapp && SKIP_LIVE=1 npx vitest run lib/__tests__/venue-networks.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and fix tests that encoded the old flags**

Run: `cd /c/Users/owner/Projects/Intent-restore/apps/dapp && SKIP_LIVE=1 npx vitest run > ../../.tmp-vitest.txt 2>&1; grep -E "FAIL|✗|×" ../../.tmp-vitest.txt | head -40`
(Capture to a file before grepping; a piped command hides the exit code.)

Likely failures: `venue-integration.test.ts`, `contract-registry` tests, anything asserting `lookupContract(<aquarius|aggregator|blend id>)` is `undefined` on mainnet, `market-context` tests. For each: change the expectation to the new truth (those three venues are on mainnet; Etherfuse, DeFindex and Noether are not). Do not weaken a test that asserts something other than venue availability. Delete `.tmp-vitest.txt` after.

Re-run until the whole suite is green.

- [ ] **Step 6: Pin that an unverified mainnet id still stays off the allowlist**

Add to `venue-networks.test.ts`:

```ts
describe('a flagged venue with no verified contract stays off the allowlist', () => {
  it('has no Noether contract on mainnet even though the registry lists it', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    const { NOETHER_MARKET, lookupContract } = await import('../swap/contract-registry')
    expect(NOETHER_MARKET).toBeUndefined()
    expect(
      lookupContract('CBHHWFAYLB3SXJCE232DC6WNSK74IBEOROAGCI2AFBA2H5NQOH2KYKNN')
    ).toBeUndefined()
    vi.unstubAllEnvs()
    vi.resetModules()
  })
})
```

Run: `SKIP_LIVE=1 npx vitest run lib/__tests__/venue-networks.test.ts` -> PASS.

- [ ] **Step 7: Update the `.env.example` paragraph**

In `apps/dapp/.env.example`, replace the lines

```
#   - knowing that only Soroswap, the classic DEX, the network's liquidity
#     pools and Soroban Domains are on mainnet at launch. Aquarius, the
#     aggregator, Blend, DeFindex, Etherfuse, Noether and every anchor stay
#     testnet-only until their mainnet contracts are verified in the code;
```

with

```
#   - knowing that Soroswap, its aggregator (needs SOROSWAP_API_KEY), Aquarius,
#     the classic DEX, the network's liquidity pools, Blend and Soroban
#     Domains are on mainnet. DeFindex, Etherfuse, Noether and every anchor
#     stay testnet-only until their mainnet details are verified in the code;
```

- [ ] **Step 8: Commit**

```bash
git -C /c/Users/owner/Projects/Intent-restore add apps/dapp/lib/venues.ts apps/dapp/lib/__tests__ apps/dapp/.env.example
git -C /c/Users/owner/Projects/Intent-restore commit -m "feat(dapp): aquarius, the soroswap aggregator and blend on mainnet"
git -C /c/Users/owner/Projects/Intent-restore show --stat HEAD
```

Check the stat lists only the files above (a failed hook leaves files staged for the next commit).

---

### Task 2: Trade cap on every Blend route that moves value

**Files:**

- Create: `apps/dapp/lib/lend/cap.ts`
- Create: `apps/dapp/lib/__tests__/lend-cap.test.ts`
- Modify: `apps/dapp/app/api/lend/build/route.ts:68-80`
- Modify: `apps/dapp/app/api/lend/borrow/route.ts:39-43,68-77`
- Modify: `apps/dapp/app/api/lend/repay/route.ts:32-35,57-69`
- Modify: `apps/dapp/app/api/lend/collateral/route.ts:38-42,71-80`
- Modify: `apps/dapp/app/api/lend/withdraw/route.ts:40-43`

**Interfaces:**

- Consumes: `assertTradeWithinCap(symbol: string, amount: string, options?: TradeCapOptions): Promise<void>` and `TradeCapOptions` from `lib/server/trade-cap.ts`; `BLEND_XLM` from `lib/lend/reserves.ts`; `fromBaseUnits(base: string): string` from `lib/swap/assets.ts`.
- Produces: `assertReserveWithinCap(asset: string, baseAmount: string, options?: TradeCapOptions): Promise<void>` in `lib/lend/cap.ts`. `asset` is a reserve contract id; XLM is priced as `XLM`, anything else is passed through by id and so has no price (refused on mainnet).

- [ ] **Step 1: Write the failing test**

Create `apps/dapp/lib/__tests__/lend-cap.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { assertReserveWithinCap } from '../lend/cap'
import { BLEND_XLM } from '../lend/reserves'
import { TradeCapExceeded } from '../server/trade-cap'
import type { MarketPrice } from '../swap/price-types'

/**
 * Blend names a reserve by contract id; the cap prices by symbol. XLM is the
 * one reserve this app can price, so it is the one that can be capped, and a
 * reserve with no price is refused on mainnet rather than estimated.
 */

const asOf = '2026-10-01T00:00:00.000Z'
const table: Record<string, MarketPrice> = {
  XLM: { symbol: 'XLM', usd: 0.2, source: 'reflector', asOf },
}
const prices = () => Promise.resolve(table)

describe('capping a Blend amount', () => {
  it('passes an XLM amount under the cap and refuses one over it', async () => {
    // 200 XLM = $40; 300 XLM = $60 against a $50 cap. Base units: 7 decimals.
    await expect(
      assertReserveWithinCap(BLEND_XLM, '2000000000', { env: {}, network: 'mainnet', prices })
    ).resolves.toBeUndefined()
    await expect(
      assertReserveWithinCap(BLEND_XLM, '3000000000', { env: {}, network: 'mainnet', prices })
    ).rejects.toThrow(TradeCapExceeded)
  })

  it('refuses a reserve it cannot price', async () => {
    await expect(
      assertReserveWithinCap('CNOTAPRICEDRESERVE', '10000000', {
        env: {},
        network: 'mainnet',
        prices,
      })
    ).rejects.toThrow(/could not be valued/)
  })

  it('reads no prices on testnet', async () => {
    await expect(
      assertReserveWithinCap(BLEND_XLM, '99999999999999', {
        network: 'testnet',
        prices: () => Promise.reject(new Error('must not be asked')),
      })
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/owner/Projects/Intent-restore/apps/dapp && SKIP_LIVE=1 npx vitest run lib/__tests__/lend-cap.test.ts`
Expected: FAIL, cannot resolve `../lend/cap`.

- [ ] **Step 3: Implement the helper**

Create `apps/dapp/lib/lend/cap.ts`:

```ts
import { assertTradeWithinCap, type TradeCapOptions } from '../server/trade-cap'
import { fromBaseUnits } from '../swap/assets'
import { BLEND_XLM } from './reserves'

/**
 * The mainnet trade cap for an amount of a Blend reserve.
 *
 * A reserve is named by contract id and the cap prices by symbol. XLM is the
 * one reserve this app can price; any other is passed through by id, finds no
 * price, and is refused on mainnet rather than estimated.
 */
export async function assertReserveWithinCap(
  asset: string,
  baseAmount: string,
  options: TradeCapOptions = {}
): Promise<void> {
  await assertTradeWithinCap(
    asset === BLEND_XLM ? 'XLM' : asset,
    fromBaseUnits(baseAmount),
    options
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `SKIP_LIVE=1 npx vitest run lib/__tests__/lend-cap.test.ts` -> PASS.

- [ ] **Step 5: Use the helper in `lend/build` (behaviour unchanged)**

In `apps/dapp/app/api/lend/build/route.ts`: change the imports

```ts
import { BLEND_XLM, readReserveList } from '../../../../lib/lend/reserves'
import { assertTradeWithinCap } from '../../../../lib/server/trade-cap'
import { fromBaseUnits } from '../../../../lib/swap/assets'
```

to

```ts
import { assertReserveWithinCap } from '../../../../lib/lend/cap'
import { readReserveList } from '../../../../lib/lend/reserves'
```

and replace the cap block (the comment and `try` at lines 68-80) with:

```ts
// Against the mainnet cap; see `assertReserveWithinCap` for how a reserve is
// priced.
try {
  await assertReserveWithinCap(body.asset, body.amount)
} catch (e) {
  return NextResponse.json(
    { error: e instanceof Error ? e.message : 'over the mainnet trade cap' },
    { status: 400 }
  )
}
```

- [ ] **Step 6: Cap `borrow`**

In `apps/dapp/app/api/lend/borrow/route.ts` add `import { assertReserveWithinCap } from '../../../../lib/lend/cap'` with the other lib imports; delete the four-line comment above `export async function POST` ("No mainnet trade cap here..."); and insert after the reserve-list `try/catch` (before `try { const built = await buildBlendBorrow`):

```ts
// A borrow adds exposure the same as a supply does, so it is capped the same.
try {
  await assertReserveWithinCap(body.asset, body.amount)
} catch (e) {
  return NextResponse.json(
    { error: e instanceof Error ? e.message : 'over the mainnet trade cap' },
    { status: 400 }
  )
}
```

- [ ] **Step 7: Cap `repay` when an amount is named**

In `apps/dapp/app/api/lend/repay/route.ts` add the same import, delete the "No mainnet trade cap here" comment, and insert after the reserve-list `try/catch`:

```ts
// An omitted amount clears the whole liability, which cannot be valued ahead
// of time. That liability can only have come from a borrow this cap already
// bounded, so repaying it is not a way to move more than the cap.
if (body.amount !== undefined) {
  try {
    await assertReserveWithinCap(body.asset, body.amount)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'over the mainnet trade cap' },
      { status: 400 }
    )
  }
}
```

- [ ] **Step 8: Cap `collateral` when posting**

In `apps/dapp/app/api/lend/collateral/route.ts` add the same import, delete the "No mainnet trade cap here" comment, and insert after the reserve-list `try/catch`:

```ts
// Posting moves the user's funds into the pool, so it is capped. Reclaiming
// returns them to a plain supply balance of the same account and is not.
if (body.direction === 'post') {
  try {
    await assertReserveWithinCap(body.asset, body.amount as string)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'over the mainnet trade cap' },
      { status: 400 }
    )
  }
}
```

- [ ] **Step 9: Say why `withdraw` is exempt**

In `apps/dapp/app/api/lend/withdraw/route.ts` replace the four-line "No mainnet trade cap here" comment with:

```ts
// No mainnet trade cap here: a withdrawal returns the account's own position
// to the account (`assertSelfPoolCall` pins `from`, `spender` and `to` to the
// signer), so it cannot move value anywhere the user did not already hold it.
```

- [ ] **Step 10: Typecheck and lint**

Run: `cd /c/Users/owner/Projects/Intent-restore/apps/dapp && npx tsc --noEmit -p . && pnpm exec next lint`
Expected: both clean (no unused imports left in `lend/build`).

- [ ] **Step 11: Whole suite, then commit**

Run: `SKIP_LIVE=1 npx vitest run` -> green.

```bash
git -C /c/Users/owner/Projects/Intent-restore add apps/dapp/lib/lend apps/dapp/lib/__tests__/lend-cap.test.ts apps/dapp/app/api/lend
git -C /c/Users/owner/Projects/Intent-restore commit -m "feat(dapp): the mainnet trade cap on blend borrow, repay and collateral"
git -C /c/Users/owner/Projects/Intent-restore show --stat HEAD
```

---

## Phase C: hardening (branch `feat/mainnet-hardening`)

Run once before Task 3:

```bash
git -C /c/Users/owner/Projects/Intent-restore switch -c feat/mainnet-hardening main
```

### Task 3: Perps submit is venue-gated like prepare (M2)

**Files:**

- Modify: `apps/dapp/lib/perps/order-flow.ts:212-228`
- Create: `apps/dapp/lib/__tests__/perps-submit-venue.test.ts`

**Interfaces:**

- Consumes: `assertVenueOn(id: string, network?)` from `lib/venues.ts` (already imported in `order-flow.ts`); the module's `failure(e: unknown): OrderFailure`, which maps a plain `Error` to `{ ok: false, code: 'refused', error }`.
- Produces: `submitOrder` returns `{ ok: false, code: 'refused', error: 'Noether is not on mainnet yet' }` on mainnet without calling the gateway.

- [ ] **Step 1: Write the failing test**

Create `apps/dapp/lib/__tests__/perps-submit-venue.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { submitOrder } from '../perps/order-flow'

/**
 * `prepareOrder` refuses a venue that is not on the network; submit must too.
 * Without it, a testnet-signed envelope with matching arguments is forwarded
 * to the testnet gateway from a mainnet deployment.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

function fakeClient() {
  return {
    readHealth: vi.fn().mockRejectedValue(new Error('gateway reached')),
    submit: vi.fn(),
  }
}

describe('submitting a perp order on a network Noether is not on', () => {
  it('refuses before the gateway is asked for anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    const client = fakeClient()
    const result = await submitOrder({
      client: client as never,
      token: 't',
      request: {} as never,
      signedXdr: 'AAAA',
    })
    expect(result).toMatchObject({ ok: false, code: 'refused' })
    expect((result as { error: string }).error).toMatch(/not on mainnet/)
    expect(client.readHealth).not.toHaveBeenCalled()
    expect(client.submit).not.toHaveBeenCalled()
  })

  it('still reaches the gateway on testnet', async () => {
    const client = fakeClient()
    await submitOrder({
      client: client as never,
      token: 't',
      request: {} as never,
      signedXdr: 'AAAA',
    })
    expect(client.readHealth).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/owner/Projects/Intent-restore/apps/dapp && SKIP_LIVE=1 npx vitest run lib/__tests__/perps-submit-venue.test.ts`
Expected: first test FAIL (`readHealth` was called).

- [ ] **Step 3: Add the gate**

In `apps/dapp/lib/perps/order-flow.ts`, in `submitOrder`, after the destructuring `const { client, token, request, signedXdr } = options` and before the `// The contracts are resolved again here` comment, insert:

```ts
// The same venue check as prepare. A signature made on one network must not
// be forwarded by a deployment running on another.
try {
  assertVenueOn('noether')
} catch (e) {
  return failure(e)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `SKIP_LIVE=1 npx vitest run lib/__tests__/perps-submit-venue.test.ts lib/__tests__/perp-order-flow.test.ts` -> PASS.

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/owner/Projects/Intent-restore add apps/dapp/lib/perps/order-flow.ts apps/dapp/lib/__tests__/perps-submit-venue.test.ts
git -C /c/Users/owner/Projects/Intent-restore commit -m "fix(dapp): perps submit refuses a venue that is not on the network"
git -C /c/Users/owner/Projects/Intent-restore show --stat HEAD
```

---

### Task 4: A server-side slippage ceiling (M3)

**Files:**

- Create: `apps/dapp/lib/swap/slippage.ts`
- Create: `apps/dapp/lib/__tests__/slippage.test.ts`
- Modify: `apps/dapp/app/api/swap/build/route.ts:59-73,128-141`

**Interfaces:**

- Consumes: `DEFAULT_SLIPPAGE_BPS` (= 50) from `lib/swap/build-tx.ts`.
- Produces: `MAX_SLIPPAGE_BPS = 500`; `checkSlippageBps(raw: unknown): { ok: true; bps: number | undefined } | { ok: false; error: string }`. `undefined` or `null` means "use the default".

- [ ] **Step 1: Write the failing test**

Create `apps/dapp/lib/__tests__/slippage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { DEFAULT_SLIPPAGE_BPS } from '../swap/build-tx'
import { MAX_SLIPPAGE_BPS, checkSlippageBps } from '../swap/slippage'

/**
 * The client may ask for a tolerance; the server decides how much is too much.
 * At 10 000 bps `destMin` is zero and the network fills the swap at any price.
 */

describe('the slippage ceiling', () => {
  it('sits above the default, or the default would be refused', () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBeLessThanOrEqual(MAX_SLIPPAGE_BPS)
  })

  it('accepts nothing, null, zero, and anything up to the ceiling', () => {
    expect(checkSlippageBps(undefined)).toEqual({ ok: true, bps: undefined })
    expect(checkSlippageBps(null)).toEqual({ ok: true, bps: undefined })
    expect(checkSlippageBps(0)).toEqual({ ok: true, bps: 0 })
    expect(checkSlippageBps(MAX_SLIPPAGE_BPS)).toEqual({ ok: true, bps: MAX_SLIPPAGE_BPS })
  })

  it('refuses a tolerance above the ceiling, naming it', () => {
    const out = checkSlippageBps(MAX_SLIPPAGE_BPS + 1)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain(String(MAX_SLIPPAGE_BPS))
  })

  it('refuses a value that is not a whole non-negative number', () => {
    for (const bad of ['50', 12.5, -1, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      expect(checkSlippageBps(bad).ok, String(bad)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/owner/Projects/Intent-restore/apps/dapp && SKIP_LIVE=1 npx vitest run lib/__tests__/slippage.test.ts`
Expected: FAIL, cannot resolve `../swap/slippage`.

- [ ] **Step 3: Implement**

Create `apps/dapp/lib/swap/slippage.ts`:

```ts
/**
 * The most slippage tolerance the server will build a swap with, in basis
 * points. The UI offers a few tenths of a percent; a request above this is not
 * a setting, it is a swap with no floor.
 */
export const MAX_SLIPPAGE_BPS = 500

export type SlippageCheck = { ok: true; bps: number | undefined } | { ok: false; error: string }

/** `undefined` (or `null`) means the caller named none, and the default applies. */
export function checkSlippageBps(raw: unknown): SlippageCheck {
  if (raw === undefined || raw === null) return { ok: true, bps: undefined }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return { ok: false, error: 'slippageBps must be a whole number of basis points' }
  }
  if (raw > MAX_SLIPPAGE_BPS) {
    return {
      ok: false,
      error: `slippageBps ${raw} is above the ${MAX_SLIPPAGE_BPS} this app allows`,
    }
  }
  return { ok: true, bps: raw }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `SKIP_LIVE=1 npx vitest run lib/__tests__/slippage.test.ts` -> PASS.

- [ ] **Step 5: Use it in the build route**

In `apps/dapp/app/api/swap/build/route.ts` add `import { checkSlippageBps } from '../../../../lib/swap/slippage'` beside the other `lib/swap` imports. After the `quote is required` check (before `const submitted = body.quote as SwapQuote`), insert:

```ts
const slippage = checkSlippageBps(body.slippageBps)
if (!slippage.ok) {
  return NextResponse.json({ error: slippage.error }, { status: 400 })
}
```

Then replace

```ts
const slippageBps = typeof body.slippageBps === 'number' ? body.slippageBps : DEFAULT_SLIPPAGE_BPS
```

with

```ts
const slippageBps = slippage.bps ?? DEFAULT_SLIPPAGE_BPS
```

and replace

```ts
      ...(typeof body.slippageBps === 'number' ? { slippageBps: body.slippageBps } : {}),
```

with

```ts
      ...(slippage.bps !== undefined ? { slippageBps: slippage.bps } : {}),
```

- [ ] **Step 6: Typecheck, then commit**

Run: `npx tsc --noEmit -p . && pnpm exec next lint && SKIP_LIVE=1 npx vitest run` -> green.

```bash
git -C /c/Users/owner/Projects/Intent-restore add apps/dapp/lib/swap/slippage.ts apps/dapp/lib/__tests__/slippage.test.ts apps/dapp/app/api/swap/build/route.ts
git -C /c/Users/owner/Projects/Intent-restore commit -m "fix(dapp): a server-side ceiling on swap slippage tolerance"
git -C /c/Users/owner/Projects/Intent-restore show --stat HEAD
```

---

### Task 5: The sponsor's fee cap follows the transaction's shape (M11)

**Files:**

- Modify: `apps/dapp/lib/sponsor/fee-bump.ts:29-37,51,95`
- Modify: `apps/dapp/lib/__tests__/fee-bump.test.ts`

**Interfaces:**

- Consumes: `Transaction.operations[].type` from `@stellar/stellar-sdk`.
- Produces: `sponsorFee` unchanged in signature. Default cap is 100 000 stroops (0.01 XLM) for a classic inner transaction and 10 000 000 (1 XLM) when any operation is `invokeHostFunction`, `extendFootprintTtl` or `restoreFootprint`. An explicit `options.maxFeeStroops` still overrides both.

- [ ] **Step 1: Write the failing tests**

In `apps/dapp/lib/__tests__/fee-bump.test.ts` add `StrKey` to the sdk import, then add a helper after `unsigned()`:

```ts
function sorobanInner(fee: string): string {
  const tx = new TransactionBuilder(new Account(user.publicKey(), '1'), {
    fee,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: StrKey.encodeContract(Buffer.alloc(32)),
        function: 'swap',
        args: [],
        auth: [],
      })
    )
    .setTimeout(60)
    .build()
  tx.sign(user)
  return tx.toXDR()
}
```

and inside `describe('sponsorFee', ...)`:

```ts
it('caps a classic transaction far below a Soroban one by default', () => {
  // 0.5 XLM is a request, not a fee, for a transaction with no contract call.
  const out = sponsorFee(inner({ fee: '5000000' }), user.publicKey(), {
    sponsor,
    passphrase: Networks.TESTNET,
  })
  expect(out).toEqual({ ok: false, reason: 'fee_over_cap' })
})

it('still bumps a classic transaction at an ordinary fee by default', () => {
  const out = sponsorFee(inner({ ops: 10 }), user.publicKey(), {
    sponsor,
    passphrase: Networks.TESTNET,
  })
  expect(out.ok).toBe(true)
})

it('bumps a Soroban transaction at its real resource fee by default', () => {
  const out = sponsorFee(sorobanInner('250000'), user.publicKey(), {
    sponsor,
    passphrase: Networks.TESTNET,
  })
  expect(out.ok).toBe(true)
})

it('still refuses a Soroban transaction whose fee is beyond any resource fee', () => {
  const out = sponsorFee(sorobanInner('50000000'), user.publicKey(), {
    sponsor,
    passphrase: Networks.TESTNET,
  })
  expect(out).toEqual({ ok: false, reason: 'fee_over_cap' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/owner/Projects/Intent-restore/apps/dapp && SKIP_LIVE=1 npx vitest run lib/__tests__/fee-bump.test.ts`
Expected: "caps a classic transaction far below..." FAIL (a 0.5 XLM classic fee is currently allowed). If `Operation.invokeContractFunction` rejects `auth: []` under SDK 17, drop that line (the aggregator test passes it with a `source`, so both forms exist).

- [ ] **Step 3: Implement**

In `apps/dapp/lib/sponsor/fee-bump.ts` replace the `maxFeeStroops` doc comment and the default constant:

```ts
  /**
   * The most the sponsor will pay for one transaction, in stroops.
   *
   * By default it follows the transaction's shape. A classic transaction costs
   * a few hundred stroops, so anything above 0.01 XLM is a request rather than
   * a fee. A Soroban call's resource fee runs to a fraction of an XLM, so those
   * keep one XLM. A single ceiling for both let a handful of classic
   * submissions at the Soroban limit spend the day's budget for everyone.
   */
  maxFeeStroops?: bigint
```

```ts
const DEFAULT_CLASSIC_MAX_FEE_STROOPS = BigInt(100_000)
const DEFAULT_SOROBAN_MAX_FEE_STROOPS = BigInt(10_000_000)

/** Operations whose fee includes a Soroban resource fee. */
const SOROBAN_OPERATIONS = new Set(['invokeHostFunction', 'extendFootprintTtl', 'restoreFootprint'])

function carriesSoroban(tx: Transaction): boolean {
  return tx.operations.some((op) => SOROBAN_OPERATIONS.has(op.type))
}
```

and replace

```ts
const cap = options.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS
```

with

```ts
const cap =
  options.maxFeeStroops ??
  (carriesSoroban(inner) ? DEFAULT_SOROBAN_MAX_FEE_STROOPS : DEFAULT_CLASSIC_MAX_FEE_STROOPS)
```

- [ ] **Step 4: Run to verify it passes**

Run: `SKIP_LIVE=1 npx vitest run lib/__tests__/fee-bump.test.ts lib/__tests__/sponsor.test.ts lib/__tests__/sponsor-mainnet.test.ts lib/__tests__/sponsor-route.test.ts` -> PASS. If a sponsor test builds a classic envelope with a fee above 0.01 XLM and expects it sponsored, give that test an explicit `maxFeeStroops` rather than changing the default.

- [ ] **Step 5: Update the env note**

The `.env.example` sponsor paragraph needs no change (no variable moved). Confirm with `grep -n "1 XLM" apps/dapp/.env.example`; if it states a per-bump cap, correct it to "0.01 XLM classic, 1 XLM Soroban".

- [ ] **Step 6: Whole suite, typecheck, lint, commit**

Run: `npx tsc --noEmit -p . && pnpm exec next lint && SKIP_LIVE=1 npx vitest run` -> green.

```bash
git -C /c/Users/owner/Projects/Intent-restore add apps/dapp/lib/sponsor/fee-bump.ts apps/dapp/lib/__tests__/fee-bump.test.ts
git -C /c/Users/owner/Projects/Intent-restore commit -m "fix(dapp): the sponsor fee cap follows the shape of the transaction"
git -C /c/Users/owner/Projects/Intent-restore show --stat HEAD
```

---

## Self-review

- **Coverage:** B1-B3 and B5 from the todo list are Tasks 1-2 (B2's M1 note moved to Out of scope with reason; B4 Etherfuse deferred with reason). C1, C2, C3 are Tasks 3, 4, 5. C5-C7, M5-M10 deferred and named.
- **Placeholders:** none; every code step has code. Step 5 of Task 1 is a discovery step by nature (it lists the files likely to fail and the rule for fixing them).
- **Types:** `assertReserveWithinCap(asset, baseAmount, options?)` is the same in Task 2's test, helper and route snippets. `checkSlippageBps` returns `{ ok, bps }` / `{ ok: false, error }` in test, implementation and route. `sponsorFee` signature unchanged.
- **Review Focus** lines each map to a test: Task 1 Step 6, Task 2 "refuses a reserve it cannot price" and the uncapped repay/reclaim comments, Task 4's bad-input loop, Task 5's Soroban-at-real-fee test.
