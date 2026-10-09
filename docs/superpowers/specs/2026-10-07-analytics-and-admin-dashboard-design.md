# Analytics: an execution log in the dapp and a separate admin dashboard

Status: draft for review. Branch `docs/analytics-design`.

## Goal

Know, and be able to prove, how much Intent is used: total volume, number of transactions, unique and returning wallets, top wallets, venues used, and fees sponsored. The numbers back grant and funding applications, so they have to be verifiable by someone who does not trust us, and mainnet and testnet must never be mixed.

Two deliverables:

1. Two small **append-only logs** in the dapp (this repo): one record per submitted transaction (`usage_executions`), and one per agent competition and per agent in it (`agent_races`, `agent_proposals`).
2. An **admin dashboard** in its own private repo, `Cookit-labs/intent-admin-dashboard`, that turns those records and the chain into the metrics.

## Why the log has to come first

The dapp records no trades. Its database holds the waitlist, standing rules, rate limits, the sponsor ledger and sent alerts. Swap history is read from the chain by looking for Intent's memos (`intent:swap:v1` and the others). That works for one wallet's history, but Horizon cannot search the whole network by memo, so there is no way to count Intent's usage from the chain alone without scanning every transaction. Whatever is not logged from the start can only be partly rebuilt later. A log row also carries the transaction hash, and the hash is what makes each number checkable on a public explorer.

## Part 1: the logs (dapp)

### Executions

One table, written by every `submit` route when a signed transaction is sent.

```
usage_executions
  id            uuid        primary key
  network       text        'testnet' | 'mainnet'
  hash          text        the transaction hash, null if the network refused it before a hash existed
  account       text        the wallet address (public on-chain)
  kind          text        swap | plan | offer | send | lend | offramp | perp
  fee_sponsored boolean
  ok            boolean     whether the network accepted it
  failure       text        a fixed code (never the upstream message), null when ok
  submitted_at  timestamptz
  unique (network, hash)
```

- **Appended in the same request** that submits, after the result is known. A failure to write the row never fails or delays the user's transaction: it is reported and the submit still answers normally.
- **No amounts, no prices, no emails.** What a transaction moved is read back from the chain afterwards (Part 2). The log stays tiny and cannot disagree with the ledger.
- **Per network** with no extra machinery: the row carries the request's network, which the per-request network work already provides.
- **Retention.** The tables are append-only; nothing in the app updates or deletes rows.
- **Creation.** The tables are created on first use with idempotent statements, like the others here, and mirrored as a numbered migration file in `packages/db/migrations`.
- **A guard:** a test fails if any `submit` route does not record, so a route added later cannot leave a hole in the numbers.

### Agent races

The AI agents are a core part of what Intent is, so their activity is tracked too.

```
agent_races      one row per competition
  id, network, started_at, intent_type, token_in, token_out, size_usd,
  agents (how many raced), answered (how many proposed), winner, unanimous,
  outcome ('winner' | 'no_winner' | 'no_agent_answered'), duration_ms

agent_proposals  one row per agent in a race
  race_id, agent, model, ok, failure (a fixed code), latency_ms,
  score, won, route_id, execution_mode
```

- Written by the competition route when the race ends, including a race nobody answered.
- **No intent text and nothing an agent wrote.** An agent's error is sorted into a small fixed set (`timeout`, `rate_limited`, `auth`, `invalid_response`, `error`); the size is the app's own USD estimate of the intent, which may be empty.
- Not linked to a transaction yet. Which race led to which execution, and so execution quality, is the next design.

## Part 2: the admin dashboard (new repo)

### Data flow

```
dapp DB (usage_executions, read-only role)  ->  ingester  ->  analytics DB (own database)  ->  dashboard
                                              ^
                       Horizon: the transaction, its effects, its fee
                       Oracle prices at the ledger's close time
```

- The dashboard has **its own database**. An ingester reads new `executions` rows through a read-only database role, asks Horizon what each transaction actually did, values it in USD, and stores the facts. The dapp's database is never written to by the dashboard.
- The analytics database can be dropped and rebuilt from `executions` and the chain, so it is never the only copy of anything.
- **What it stores:** wallet addresses and amounts. It never reads emails, standing rules or the waitlist, so a leak of the dashboard cannot expose them.

### Definitions, fixed up front

- **Volume** is the USD value of what the user sold or sent: the input leg of a swap, plan leg or offer fill, the amount of a send. Lending and perps are reported as their own lines (supplied, borrowed, notional) and are not added into headline volume.
- **USD value** is taken at the ledger close time from the same oracle the app prices with. If no price exists for that moment the transaction is counted but marked unvalued, never guessed.
- **A transaction counts** only if the chain shows it succeeded.
- **Mainnet and testnet** are separate throughout. Every view takes a network and there is no combined total.

### What the first version shows

- Overview for a chosen network and date range: volume, transactions, unique wallets, new versus returning wallets, weekly active wallets, fees sponsored and cost per sponsored transaction.
- Time series of volume and transactions.
- Top wallets by volume and by transaction count (addresses link to the explorer).
- **Agents:** races run, how often an agent answers, its win rate, its median and 95th-percentile response time, what it fails on, how often the agents agree, and a comparison across models. Per network and date range, like everything else.
- Breakdown by kind, venue and asset.
- Retention at 7 and 30 days.
- Every figure that is a count of transactions links to the list behind it, and every row to its transaction on the explorer.
- CSV export of any table.

### Access

Sign-in with GitHub, limited to members of the `Cookit-labs` organisation. No shared password and no separate user table. Server-side checks on every data route, not only on pages.

### Public totals (later, separate)

A public page of totals only (volume, transactions, unique wallets, growth), no wallet detail and no admin routes, for linking in applications. Out of scope for the first version; the data model supports it without change.

## Integrity

- A nightly reconciliation compares the count and total of ingested transactions with a re-read of the chain for the same hashes and reports any difference.
- The ingester is idempotent: running it twice produces the same rows.
- A transaction that failed on the network is kept in the log with `ok = false` and excluded from every metric, so the failure rate is visible without polluting volume.

## Not in scope

- Execution quality (the winning quote against the best single venue). It needs a race linked to the transaction it led to, and is the next design, after this one proves out.
- A public API, alerts, and per-user views.
- Backfilling transactions made before the log exists. Wallets known from the sponsor ledger can be backfilled by memo, on request.

## Testing

- Log: a row is written for each submit route on success and on failure; a failing write does not change the response; two submits of the same hash write one row; rows are per network.
- Ingester: valuation, the volume definition for each kind, unvalued handling, idempotence, and a transaction that failed on chain.
- Dashboard: sign-in refuses a non-member on pages and on data routes; every network view shows only that network; figures match a fixture ledger.

## Phasing

1. **The logs** in this repo: tables, migration, writes from the eight submit routes and the competition route, tests. Small and independent.
2. **The dashboard repo skeleton**: Next.js app, GitHub sign-in with the organisation check, read-only database role, CI, secret scan.
3. **The ingester and the metrics** in the order above.
4. **Public totals** and execution quality, as separate designs.

## Open choices

- Where the dashboard and its database are hosted. Vercel with a managed Postgres fits the rest of the project; any host works because it only needs the two databases and Horizon.
- The price source for historical USD values if the oracle cannot give a value at a past ledger time.
