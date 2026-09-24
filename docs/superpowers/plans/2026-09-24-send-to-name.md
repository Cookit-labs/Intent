# Send to a name

**Goal:** "send 50 USDC to deon.xlm", "pay 10 XLM to alice\*lobstr.co" and "send 25 USDC to GABC…" execute as one signed payment on testnet, with the recipient resolved on the server, shown beside its name on the review card, pinned in a local address book, and resolved again at submit. "Swap $50 USDC to XLM, then send it to bob.xlm" runs as a swap-then-send sequence.

**Architecture:** a `lib/names` module resolves three recipient forms (raw account, SorobanDomains `.xlm`, SEP-2 federation) into one `ResolvedRecipient`. A `lib/send` module builds and asserts a single classic `payment`, mirroring `lib/offramp/build-payment.ts` field for field. Three routes under `app/api/send` resolve, build and submit; submit re-resolves the name and refuses a moved address. The chat gains a `send-only` intent parsed before the LLM path, and `use-sequence` gains `swap-then-send`.

**Verified facts (2026-09-24), do not re-derive:**

- SorobanDomains registry v2 lives on **mainnet only**: `CC75Z72OCE667WVPQOROIWDAGBOXFNJ4VQONQEURL74EYIDLWA4F7FEN`. RPC `https://mainnet.sorobanrpc.com`, fallback `https://rpc.lightsail.network`. Simulation account `GALAXYVOIDAOPZTDLHILAJQKCVVFMD4IKLXLSZV5YHO7VY74IWZILUTO` (funded, no secret needed). The app at app.sorobandomains.org references no testnet ids, so there is no testnet registry to use. Names are resolved on mainnet; the payment runs on testnet. The review card says "name resolved on Stellar mainnet".
- Node hashing: root `node = keccak256(keccak256(tld) ‖ keccak256(label))`; subdomain `node = keccak256(keccak256(parentNode) ‖ keccak256(sub))`. Labels are lowercase a–z, 1–15 chars. TLD `xlm`.
- Read: simulate `record(RecordKey)` on the registry with `RecordKey = ScVal.scvVec([scvSymbol('Domain'|'SubDomain'), scvBytes(node)])`. Returns a tuple `(Domain, Option<SubDomain>)`; `Domain.address` is the target (for a subdomain use the `SubDomain.address`). The contract itself refuses expired domains. A missing name simulates to `HostError: Error(Contract, #307)`. Validated: `sorobandomains.xlm` → `GBGFEZ5QZFLQJTTCQUYWTJBGZN6QEVFF57F3LVD2MF7MRYWUNKFBJWIV`.
- Federation (SEP-2): `name*domain` → `https://<domain>/.well-known/stellar.toml` → line `FEDERATION_SERVER="…"` → `GET <server>?q=<name*domain>&type=name` → `{ account_id, memo_type?, memo? }` with `memo_type ∈ text|id|hash`. Validated: `lobstr*lobstr.co` → `GARSCEEOGZ4MGOTZLQHOKJGOPK455N6SHD7SAEFFHIJDAV445GFWJGHD`. `testanchor.stellar.org`, `stellar.moneygram.com` and `mykobo.co` publish no federation server.
- keccak: `@noble/hashes` `^1.8.0` is in the pnpm store already; add it to `apps/dapp` dependencies (`pnpm add @noble/hashes@^1.8.0 --filter @intent/dapp`) and import `keccak_256` from `@noble/hashes/sha3`.
- Existing patterns to mirror, read them first: `lib/offramp/build-payment.ts` (build + assert of a payment), `app/api/offramp/submit/route.ts` (assert → `sponsorForSubmission` → `submitSignedSwap`), `lib/lend/oracle.ts` (a contract view through an injected `serverImpl: Pick<rpc.Server, 'simulateTransaction'>`), `lib/parse-compound.ts` (`parseSupplyOnlyIntent`, `parseOfframpOnlyIntent`, `FollowOnKind`), `hooks/use-sequence.ts` (`SwapThenLend`, `SwapThenOfframp`, `OfframpOnly`), `components/intents/intent-chat.tsx` around the `parseSupplyOnlyIntent` call and the `kind: 'swap-then-lend'` / `'swap-then-offramp'` dispatches, `lib/chat-history.ts` (`bundle` steps), `lib/swap/preview.ts` (`derivePreview` already handles `payment`), `lib/__tests__/chat-history.test.ts` (how `window.localStorage` is stubbed).

## Global constraints

- Branch `feat/send-to-name`, in the worktree you were given. Commit as you go; do not push.
- commitlint: header ≤ 100 chars, lowercase after the type. No co-author lines.
- Tests first, watched failing, then the code. Vitest runs in `node` with no DOM: keep logic in `lib/`, hooks and components stay thin.
- Backslashes are eaten in heredocs through this shell: write files with the Write tool.
- Every route validates its body, never trusts a client-supplied address for a name, and re-resolves the name on the server.
- `next lint`, `tsc --noEmit`, `prettier --check` clean; `SKIP_LIVE=1 npx vitest run` green. Live tests are `*.live.test.ts` and skip when `SKIP_LIVE=1`.

---

### Task 1: SorobanDomains resolution — `lib/names/soroban-domains.ts`

**Files:** create `lib/names/soroban-domains.ts`, test `lib/__tests__/soroban-domains.test.ts`, live `lib/__tests__/soroban-domains.live.test.ts`.

**Produces:**

```ts
export const SOROBAN_DOMAINS_REGISTRY: string
export const SOROBAN_DOMAINS_RPC: string
export const SOROBAN_DOMAINS_SIMULATION_ACCOUNT: string
export function isSorobanDomain(input: string): boolean // /^[a-z]+(\.[a-z]+)*\.xlm$/ after lowercasing, each label 1–15 chars
export function domainNode(name: string): Uint8Array // as in the facts above
export class NameNotFound extends Error {
  name = 'NameNotFound'
}
export class NameLookupFailed extends Error {
  name = 'NameLookupFailed'
}
export async function resolveSorobanDomain(
  name: string,
  options?: { serverImpl?: Pick<rpc.Server, 'simulateTransaction'>; rpcUrl?: string }
): Promise<{ address: string; expiresAt: number }>
```

- Tests: `isSorobanDomain` accepts `deon.xlm`, `pay.deon.xlm`, rejects `Deon.xlm` before lowercasing? (lowercase it, accept), rejects digits, `deon.eth`, a 16-char label, `deon`. `domainNode('sorobandomains.xlm')` equals the hex you compute once with the same formula and pin as a constant in the test (compute it in the test file from `keccak_256` so the test proves the concatenation order, not the constant). `resolveSorobanDomain` with a fake `simulateTransaction` returning a tuple ScVal → address; simulation error containing `#307` → `NameNotFound`; other simulation error → `NameLookupFailed`; a network throw → `NameLookupFailed`.
- Live test: resolve `sorobandomains.xlm`, expect `GBGFEZ5QZFLQJTTCQUYWTJBGZN6QEVFF57F3LVD2MF7MRYWUNKFBJWIV`; `thisdomainshouldnotexist.xlm` → `NameNotFound`.

### Task 2: Federation — `lib/names/federation.ts`

**Produces:**

```ts
export function isFederationAddress(input: string): boolean // /^[^*]+\*[a-z0-9.-]+\.[a-z]{2,}$/i
export async function resolveFederation(
  address: string,
  options?: { fetchImpl?: typeof fetch }
): Promise<{ address: string; memo?: string; memoType?: 'text' | 'id' | 'hash' }>
```

- Toml: fetch `https://<domain>/.well-known/stellar.toml`, find `FEDERATION_SERVER`, refuse (`NameLookupFailed`) if absent or not https. Query with `encodeURIComponent`. 404 → `NameNotFound`. Validate `account_id` with `StrKey.isValidEd25519PublicKey`. Memo type outside the three → `NameLookupFailed`.
- Tests with a stubbed fetch for: happy path with memo, no federation server, 404, invalid account id. Live: `lobstr*lobstr.co` → `GARSCEEOGZ4MGOTZLQHOKJGOPK455N6SHD7SAEFFHIJDAV445GFWJGHD`.

### Task 3: One resolver — `lib/names/resolve.ts`

**Produces:**

```ts
export interface ResolvedRecipient {
  input: string
  kind: 'address' | 'soroban-domain' | 'federation'
  address: string
  memo?: string
  memoType?: 'text' | 'id' | 'hash'
  /** Where the answer came from, for the card. */
  resolvedOn?: 'stellar-mainnet' | 'federation'
}
export function recipientKind(input: string): ResolvedRecipient['kind'] | undefined
export async function resolveRecipient(
  input: string,
  options?: { resolveDomain?; resolveFederation? }
): Promise<ResolvedRecipient>
```

- A `G…` key passes through (validated). `C…` and `M…` are refused with a message saying only account addresses can be paid here. Anything unrecognised → `NameLookupFailed('not an address or a name this app can resolve')`.
- Tests with injected resolvers.

### Task 4: Address book — `lib/names/address-book.ts` (client-side)

**Produces:**

```ts
export type PinStatus =
  | { status: 'new' }
  | { status: 'known' }
  | { status: 'changed'; previous: string; pinnedAt: string }
export function checkRecipient(name: string, address: string): PinStatus
export function pinRecipient(name: string, address: string): void // overwrites, called after a successful send
```

- `localStorage` key `intent.addressbook.v1`, map name(lowercased) → `{ address, pinnedAt }`. Raw addresses are never pinned. Survives an unreadable storage (return `new`). Tests stub `window.localStorage` like `chat-history.test.ts`.

### Task 5: Parser — `lib/parse-send.ts` and a `send` follow-on

**Produces:**

```ts
export interface SendIntent {
  kind: 'send-only'
  amount: string
  amountIsUsd: boolean
  asset: string
  recipient: string
  memo?: string
}
export function parseSendIntent(raw: string, symbols: string[]): SendIntent | null
```

- Verbs: send | pay | transfer. Forms: "send 50 USDC to deon.xlm", "pay $20 of XLM to alice\*lobstr.co", "transfer 10 XLM to GABC… memo rent". The recipient token must satisfy `recipientKind` (address, `.xlm`, federation) or the parse returns null; "send it to my friend" stays null. `memo <text>` at the end is optional. Asset must be in `symbols`.
- `parse-compound.ts`: `FollowOnKind` gains `'send'`, `FollowOnAction` gains `recipient?: string`; "swap $50 USDC to XLM then send it to bob.xlm" yields `followOn: { kind: 'send', recipient: 'bob.xlm' }`. `describeFollowOn` says "send it to bob.xlm". Keep the existing rule that "send it to my friend" is not a follow-on.
- Tests for each phrasing, the null cases, and that swap-then-lend / offramp parsing is unchanged (run the existing suites).

### Task 6: Build and assert — `lib/send/build-payment.ts`

**Produces:**

```ts
export interface SendExpectation {
  recipientInput: string
  destination: string
  memo?: string
  memoType?: 'text' | 'id' | 'hash'
  amount: string
  asset: { code: string; issuer?: string }
}
export async function buildSendPayment(options: {
  account: string
  expectation: SendExpectation
  horizonUrl?: string
  fetchImpl?: typeof fetch
}): Promise<{ xdr: string; networkPassphrase: string }>
export function assertSendPayment(xdr: string, account: string, expectation: SendExpectation): void
```

- Mirror `lib/offramp/build-payment.ts`: one `payment`, source is the account, destination matches, asset matches (native allowed here), amount compared in stroops, memo matches when expected and is absent when not. Refuse `destination === account`. Reuse `memoFromAnchor` / `memoMatches` from `lib/offramp/memo.ts` for memos.
- Tests mirror the offramp assertion tests: happy path, wrong destination, wrong asset, wrong amount, missing memo, extra operation, wrong source, self-payment.

### Task 7: Routes — `app/api/send/{resolve,build,submit}/route.ts`

- `POST /api/send/resolve` `{ recipient }` → `ResolvedRecipient` or `{ error, code: 'not_found' | 'lookup_failed' | 'unsupported' }` with 404/502/400.
- `POST /api/send/build` `{ account, asset, amount, amountIsUsd?, recipient, memo? }`: resolves on the server, converts a USD amount with the same price source the swap build uses, builds, returns `{ xdr, expectation, resolved, preview }` where `preview = derivePreview(xdr, account, passphrase)` with `feePaidBy` stamped like the swap build does.
- `POST /api/send/submit` `{ signedXdr, account, recipient, asset, amount, memo? }`: resolves the recipient **again**, builds the expectation from that fresh answer, `assertSendPayment`, then `sponsorForSubmission` and `submitSignedSwap`, exactly as the offramp submit does. A name whose address changed since build fails the assertion; the message names both addresses.
- Route tests: unit-test the pure pieces; the routes themselves get a small test with a fake resolver if the repo already tests routes (see `standing-routes.test.ts`), else skip.

### Task 8: Client — sequence and card

- `hooks/use-sequence.ts`: add `SendOnly { kind: 'send-only'; asset; amount; amountIsUsd?; recipient; memo? }` and `SwapThenSend { kind: 'swap-then-send'; quote; receiveSymbol; recipient; memo?; swapLabel? }`. Step plan: send-only = one step; swap-then-send = swap step, measure delivered balance as swap-then-lend does, then a send of that amount. Each send step calls `/api/send/build` then, after signing, `/api/send/submit`.
- `components/intents/send-confirm.tsx`: the review card. Shows: amount and asset, the recipient as typed, the resolved address in full monospace (copyable), memo when present, "resolved on Stellar mainnet" for `.xlm` and "via federation at <domain>" for federation, the fee line from the preview, and the address-book line: new → "First payment to this name. Check the address."; known → "Same address as last time."; changed → a warning with the previous address, and the Sign button disabled until a checkbox "I checked the new address" is ticked. On a settled send, `pinRecipient`.
- `intent-chat.tsx`: call `parseSendIntent` before the LLM parse, next to `parseSupplyOnlyIntent`; on a hit, prepare a `send-only` sequence. For a compound intent whose `followOn.kind === 'send'`, prepare `swap-then-send`. Record the turn: single send → `txHash` and a label "Sent 50 USDC to deon.xlm"; swap-then-send → `bundle` with two steps as swap-then-lend does.
- History rows (`chat-history-panel.tsx`) need nothing new if the bundle step label carries the name.

### Task 9: Verification

- `SKIP_LIVE=1 npx vitest run` green; the two live tests pass when run without `SKIP_LIVE`.
- `npx tsc --noEmit -p .`, `pnpm exec next lint`, `prettier --check` on touched files.
- A live testnet send by raw address: two friendbot accounts, 1 XLM, through `buildSendPayment` → sign → `assertSendPayment` → `sponsorForSubmission` → `submitSignedSwap`; assert the balance moved. Put it in `lib/__tests__/send.live.test.ts` (pattern: `lib/__tests__/sponsor.live.test.ts`).
- Report: what is verified live, what is unit-only (name → payment end to end cannot be exercised on testnet because named addresses are mainnet accounts that may not exist on testnet; say that plainly).

## Non-goals

Registering names, reverse lookup, paying `C…` or `M…` addresses, path payments inside a send (the asset must be held), agents proposing sends.
