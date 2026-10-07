# Switching between Stellar mainnet and testnet inside one app

Status: draft for review. Branch `feat/network-switch`.

## Goal

A person using Intent can choose **Stellar mainnet** or **Stellar testnet** from the chain menu, in one deployment, and the app genuinely switches: venues, prices, trade limits, sponsor, saved data and the wallet check all follow the choice. Testnet is for trying things; mainnet is for real funds.

If the wallet is on a different network than the one chosen in the app, the app prompts the wallet owner to switch it, and clears the prompt by itself once the wallet is on the right network.

## Not in scope

- Arc (EVM) network switching. Arc stays testnet.
- Changing the network from inside a wallet. No wallet API allows it (see "Wallet").
- Mixing networks in one session or one transaction.

## What exists today

The network is one value, `NEXT_PUBLIC_STELLAR_NETWORK`, read once when the server starts and inlined into the browser bundle at build. 54 files read it through `stellarNetwork`, 14 through `activeNetwork()`, 7 through `STELLAR_USDC`. Four modules capture it at import (`prices/reflector`, `swap/asset-registry`, `swap/contract-registry`, `components/intents/price-ticker`), and the contract and asset registries are built from that capture. The access gate, the sponsor key and the daily sponsor ledger are all decided once for that one network. Two database tables hold network-specific data with no network label: `sponsor_ledger` and `standing_rules`.

Everything that makes mainnet safe (trade cap, venue allow-list, gate, sponsor rules) depends on that single fixed value.

## Design

### 1. The network travels in the URL

Pages move to `/stellar-mainnet/…` and `/stellar-testnet/…`. `/stellar/…` stays as a legacy path that redirects to the deployment's default network, so existing links keep working. `/arc/…` is unchanged.

Why the URL and not a cookie: with a cookie, switching network in one browser tab changes what every other tab's API calls do, so a tab can show "mainnet" while its requests go to testnet. With the network in the URL, each tab keeps its own, and a link always opens the network it names.

The route segment resolves to a chain family plus a network:

```
arc              -> { chain: 'arc' }
stellar          -> { chain: 'stellar', network: <default>, legacy: true }
stellar-mainnet  -> { chain: 'stellar', network: 'mainnet' }
stellar-testnet  -> { chain: 'stellar', network: 'testnet' }
```

`useChain()` keeps `slug: 'arc' | 'stellar'` for family logic and gains `network`.

### 2. Which networks a deployment serves

A new env var, `NEXT_PUBLIC_STELLAR_NETWORKS`, lists them (public because the browser and the edge middleware read it too), for example `testnet,mainnet`. The default, when unset, is the single network from `NEXT_PUBLIC_STELLAR_NETWORK`. In that case nothing changes: no header is read, no new behavior runs, and the menu shows only the one network, plus the existing link to another deployment if one is configured.

`NEXT_PUBLIC_STELLAR_NETWORK` remains the default network (used for `/stellar`, background jobs and anything with no request). `NEXT_PUBLIC_SOROBAN_RPC_URL` and `NEXT_PUBLIC_STELLAR_HORIZON_URL` apply to the default network only.

### 3. Per-request network on the server

Middleware computes the network for every request and sets one trusted request header, `x-intent-network`:

- **Pages:** from the URL segment.
- **API routes:** from the same header sent by the app's own fetch helper, which reads the page's network.
- Any value outside `STELLAR_NETWORKS`, or no value, becomes the default network.
- Any inbound `x-intent-network` is overwritten, never trusted as sent.

Server code reads the network only through `activeNetwork()`, which in multi-network mode reads that header via `next/headers`. In single-network mode it returns the fixed value as today.

**Fail closed.** Outside a request (a script, a scheduled job, module load) in multi-network mode, `activeNetwork()` throws instead of silently picking the default. Code that really does run without a request must name its network: the scheduled standing-rule check loops over the enabled networks, and scripts take a `--network` argument. `stellarNetwork` becomes a lookup that resolves per call, so most of the 54 call sites need no edit. The four import-time captures and the registries built from them become per-network lookups.

### 4. State separated per network

| Thing                     | Change                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fee sponsor               | `SPONSOR_SECRET_KEY_TESTNET` and `SPONSOR_SECRET_KEY_MAINNET`. The existing `SPONSOR_SECRET_KEY` applies to the default network only, never to the other one. A testnet key can never sponsor on mainnet.                                              |
| `sponsor_ledger`          | New `network` column; daily budget and per-account counts are kept per network.                                                                                                                                                                        |
| `standing_rules`          | New `network` column; every read and write filters on it, so a testnet rule cannot run on mainnet.                                                                                                                                                     |
| Rate-limit buckets        | Key includes the network, so testnet traffic cannot use up mainnet's allowance.                                                                                                                                                                        |
| Wallet-auth session token | Carries the network; routes reject a token whose network differs from the request's. The plan reads `lib/api/auth` and `lib/server/session` first to see where the token is issued and checked, then adds the claim and the check at those two points. |
| Caches and query keys     | Server caches and react-query keys include the network. The Soroswap client already does.                                                                                                                                                              |
| Health                    | Reports each enabled network's probes.                                                                                                                                                                                                                 |

`standing_rules` gets a `network TEXT NOT NULL` column whose default, for existing rows, is the deployment's current default network (they were created while it served only that one).

`sponsor_ledger` is partitioned by key instead of by a new column: rows are per day, and a network other than the deployment's default writes its account and day-total rows as `<network>:<account>` and `<network>:*`. The default network keeps the plain keys, so existing history stays its own and no table is altered. Isolation is the same and is pinned by tests.

The server-issued wallet-auth token is issued by the separate backend service, outside this repository. What this app controls is the browser's copy: the saved wallet session and the token are stored under a key per network, so one network's proof is never read on the other. Having the backend put the network in the token and check it is a follow-up in that service.

### 5. Access gate per network

`gateEnabled(env, network)`: `ACCESS_GATE=on` gates every network, `off` gates none, unset gates mainnet only. With both networks served, mainnet requires the email-code login and testnet stays open. The gate runs in middleware on the selected network, so choosing testnet gives no route to mainnet pages or to mainnet sponsorship (the sponsor already pays only for requests that carry a session when the gate is on).

### 6. Wallet and the auto-prompt

Verified in the installed libraries: the Stellar Wallets Kit exposes `setNetwork`, but that only sets which network the **kit** uses for its calls. The wallet modules expose `getNetwork()` read-only, and Freighter's API (v6) has no network-switch method. The app therefore cannot change the network inside a wallet.

What it does instead:

1. **Detect.** After connect, and again whenever the selected network changes, read the wallet's network and compare it with the selected one.
2. **Prompt automatically** on a mismatch: a prominent dialog that names both networks ("Your wallet is on Stellar testnet. Switch it to Stellar mainnet to continue"), with the steps for the connected wallet, and a second choice, "Use Stellar testnet instead", which navigates to the network the wallet is on.
3. **Clear by itself.** While a mismatch is open, re-read the wallet's network every 2 seconds (paused when the tab is hidden), so the dialog closes the moment the wallet is switched, with no reload and no "I've switched" button needed.
4. **Keep the kit aligned.** Call `StellarWalletsKit.setNetwork` for the selected network, and keep passing `networkPassphrase` on every signing call. Wallets that sign for the network given with each request work without any switch.
5. **Fail closed.** Building or signing a transaction with a known network mismatch is refused with the same prompt. The existing mismatch label and the hidden-balance rule stay.

### 7. Menu and navigation

The chain menu lists Arc, Stellar mainnet and Stellar testnet as normal entries. Choosing one navigates to the same screen under that network's path. The header badge names the network, and the mainnet trade cap shows only on mainnet. The "other deployment" link added earlier stays as the fallback for a deployment that serves a single network.

## Threats considered

| Threat                                                                  | Mitigation                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client sends `x-intent-network: mainnet` to reach mainnet without login | The header is overwritten in middleware from the URL or a validated value; mainnet routes and sponsorship then require the session because the gate is evaluated for mainnet. |
| Client picks testnet to dodge the mainnet limits                        | Testnet has no real funds; limits are per network and the sponsor key is separate.                                                                                            |
| A request with no network silently runs on the default                  | `activeNetwork()` throws outside a request in multi-network mode; jobs name their network.                                                                                    |
| Testnet standing rule fires on mainnet                                  | `network` column plus a filter on every query; the tick runs per network.                                                                                                     |
| Mainnet sponsor budget consumed by testnet use                          | Ledger rows and budgets are per network.                                                                                                                                      |
| Stale tab acts on the wrong network                                     | The network is in the URL and in every API call's header, per tab.                                                                                                            |
| Wallet on the wrong network signs                                       | Signing is refused on a known mismatch; the passphrase is always sent.                                                                                                        |

## Testing

- Unit: route-segment parsing; network resolution and the overwrite of a spoofed header; the enabled-networks parser; per-network registries, trade cap and venue gating; sponsor key selection per network; ledger and rule isolation (a row in one network is invisible to the other); the per-network gate; the mismatch check and polling.
- Integration: with `NEXT_PUBLIC_STELLAR_NETWORKS=testnet,mainnet`, the same API route called with each network returns that network's contracts and limits; with one network configured, behavior is byte-for-byte the current behavior (the existing suite must pass unchanged).
- Browser: Playwright run that opens both paths, switches from the menu, and checks the label, cap, venues and the mismatch dialog with a faked wallet network.

## Phasing

Each phase merges on its own and is inert until `STELLAR_NETWORKS` lists more than one network.

1. **Core.** Route parsing, `STELLAR_NETWORKS`, middleware header, per-request `activeNetwork()`, lazy registries and constants, fail-closed behavior.
2. **State.** Sponsor keys, ledger and standing-rule migrations, rate-limit keys, session-token network, per-network gate and health.
3. **UI.** Menu entries, legacy redirect, fetch helper, wallet detection and the auto-prompt.
4. **Hardening.** The threat table as tests, a security review, and a staging run with both networks.

## Open risks

- The scope is large (about 60 files, two migrations). The phasing and the single-network default are what keep a mistake from reaching today's behavior.
- Wallets differ: some honor the network sent with each signing request, some do not. The prompt covers both.
- A funded mainnet sponsor key and a mainnet-capable database are prerequisites for turning mainnet on in any deployment.
