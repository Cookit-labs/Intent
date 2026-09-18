# Offramping to fiat through SEP-24 anchors

## Context

"Sell 500 XLM and send the dollars to my bank" is a natural thing to ask an
intent marketplace, and today no layer of the app can express it. The request
arrived as "integrate Veil's invisible wallet offramp", but that package
(`invisible-wallet-sdk` 0.2.0, one version, published 2026-09-03) contains no
offramp: every export was read, and `bulkPayout` — the only plausible name —
is a CSV batch sender for on-chain payments to Stellar addresses. The README
has zero occurrences of offramp, fiat, bank, withdraw, anchor, KYC, SEP-6 or
SEP-24.

On Stellar, moving value off-chain is done by **anchors** speaking **SEP-24**:
the app authenticates the user's account (SEP-10), asks the anchor to start a
withdrawal, the anchor hosts KYC and collects bank details in its own page,
and once ready it names an account and a memo. The app then sends the asset
there as a plain payment; the anchor pays out fiat. Every fact below about
that protocol was verified against live endpoints on 2026-09-18, not
recalled.

Two anchors have working testnets and were confirmed reachable:

|               | `testanchor.stellar.org`                                   | `extstellar.moneygram.com`                                     |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Who           | SDF reference anchor                                       | MoneyGram Access                                               |
| SEP-24        | `https://testanchor.stellar.org/sep24`                     | `https://extstellar.moneygram.com/stellaradapterservice/sep24` |
| Auth          | `https://testanchor.stellar.org/auth`                      | `https://extstellar.moneygram.com/stellaradapterservice/auth`  |
| `SIGNING_KEY` | `GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR` | `GCSESAP5ILVM6CWIEGK2SDOCQU7PHVFYYT7JNKRDAQNVQWKD5YEE5ZJ4`     |
| USDC withdraw | min 1, max **10**, no fee                                  | min 1, max 2500, fee enabled                                   |
| KYC           | fake, instant                                              | test flow                                                      |

Both accept USDC from issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`,
which is the app's canonical testnet USDC ([assets.ts](../../../apps/dapp/lib/swap/assets.ts)).
One trustline serves the swap and the offramp. `anchor-sep24.stellar.org`,
cited in older material, does not resolve and must not be used.

## The constraints that shape everything

### The validator forbids exactly this

[plan-validator.ts:47](../../../apps/dapp/lib/swap/plan-validator.ts#L47):

> `payment` — the whole point. A plan must not move funds to a third party.

An offramp is, mechanically, a payment to a third party. Every integration so
far — Soroswap, Aquarius, Blend, the classic book — returns value to the
signer, which is why `assertSelfPlan` can refuse any other destination outright
and why the numbered review list is trustworthy. This feature is the first
that must send funds away, and the design question is not "how to call the
anchor" but **what makes one third-party destination signable when all others
are refused.**

### Funds move at one exact moment, and three silent failures surround it

From the SEP-24 specification, verified:

1. **Nothing is sent until the anchor's transaction reaches
   `pending_user_transfer_start`.** Before that the anchor has provisioned no
   destination; a payment sent early goes to an account not expecting it.
2. **The anchor's receiving account is shared across all its users.** The
   memo the anchor returns (`withdraw_memo`, typed by `withdraw_memo_type`) is
   the only thing that attributes a payment to a withdrawal. A payment with no
   memo, or the wrong memo type, is lost — recovery is a support ticket.
3. **The destination is per transaction.** Anchors rotate pooled accounts.
   Caching `withdraw_anchor_account` from a previous withdrawal, or from
   configuration, sends funds to the wrong place.

None of these raise an error. They take the money. So the guard cannot be "is
this address on a list"; it must be **"does every field of this payment match
what the anchor said about this specific transaction, read from the anchor
right now."**

### Freighter cannot use the wallet SDK

`@stellar/typescript-wallet-sdk` 5.0.0 was unpacked and read.
`WalletSigner.signWithClientAccount` is synchronous and returns `Transaction`;
`SigningKeypair` throws without a local secret. Freighter signs asynchronously
through an extension prompt, so a conforming signer cannot be written. The SDK
also hard-pins `@stellar/stellar-sdk` at `17.0.1`, so the next root bump nests
a second copy and breaks `instanceof` across `Asset` and `Transaction` — the
trap the Blend integration avoided by hand-rolling.

**Decided: no SDK.** SEP-10 and SEP-24 are REST plus one signed transaction,
which is what `lib/lend/blend-client.ts` already does for a harder protocol.

## Design decisions

**An offramp payment is never part of a plan.** `payment` stays absent from
`ALLOWED_OPERATIONS`, and the comment there stays true. The payment is built
as its own single-operation transaction — exactly as a Blend supply is — and
admitted only by a dedicated assertion, `assertOfframpPayment`, that checks it
against the anchor's own answer. The general validator keeps its guarantee
unchanged; the exception has its own gate, its own tests, and its own name in
a refusal.

**The server reads the anchor, never the browser.** The route that builds the
payment takes the anchor id, the anchor's transaction id and the user's JWT,
and fetches the transaction from the anchor itself. Destination, memo, amount
and asset come from that response and nothing else. The submit route fetches
it again before broadcasting, so two independent reads from the anchor bracket
the signature. A compromised page can ask for the wrong withdrawal; it cannot
name the destination.

**Anchors are an allowlist, mirroring `contract-registry.ts`.** Each entry
pins the home domain and the `SIGNING_KEY`. At runtime the TOML is fetched and
its key compared to the pinned one; a mismatch refuses the anchor rather than
trusting the network. Key rotation is a deliberate code change, the same
discipline applied to contract ids.

**USDC only, at first.** It is the one asset both anchors withdraw, and it is
the app's canonical one. A swap-then-offramp therefore always swaps _into_
USDC; an agent may choose the route but not the asset.

**The sequence settles when the payment confirms on-chain.** What happens
after — the anchor moving fiat through a bank — is the anchor's work, takes
hours to days, and is tracked afterwards as an open position rather than
holding the sequence open. The user is shown where their money is at every
stage, but the app does not pretend to control the part it cannot.

**A compound intent is a sequence, not a bigger intent.** Same shape as the
Blend work: `parseCompoundIntent` gains a second `FollowOnKind`, the sequence
hook gains a second request variant, and the agent vocabulary gains a second
`thenAction`. Nothing about single-action intents changes.

**Agents compete on the swap, not the offramp.** Which anchor, and whether to
offramp at all, are the user's instruction — an agent proposing to send funds
off-chain when nobody asked is a different product. What the agent decides is
the route into USDC and whether to fill or rest first, which is where its
judgement is measurable. Live anchor limits go into the market context so an
agent can say "this exceeds what the anchor accepts" rather than propose a
step that will be refused.

## Security model

Stated as a list because each item is a distinct way to lose money.

### SEP-10 challenge verification, before Freighter is asked to sign

The anchor returns a transaction. Before it reaches the wallet, the client
verifies, in order:

1. Source account equals the anchor's `SIGNING_KEY` — the pinned one.
2. Sequence number is `0`. A sequence-0 transaction can never be submitted to
   the network, which is what makes signing it safe.
3. Time bounds contain now.
4. The first operation is `manageData`, sourced by **the user's account**, with
   key `<home domain> auth`.
5. A `web_auth_domain` operation exists, sourced by the anchor, naming its
   domain.
6. The anchor's signature over the envelope verifies against the pinned key.
   Skipping this is the man-in-the-middle hole: an attacker who can answer
   the challenge request could otherwise present any transaction.
7. No operation other than `manageData` is present.

A failure on any of these refuses the sign and names the check that failed.
The wallet prompt the user sees is for a transaction that cannot move funds.

### The payment assertion

`assertOfframpPayment(xdr, account, expected)` where `expected` was read from
the anchor by the server:

- Not a fee-bump.
- Source equals the user's account.
- Exactly one operation, of type `payment`, with no per-operation source.
- `destination` equals `withdraw_anchor_account` from the anchor response.
- Asset code and issuer equal the withdrawal asset — USDC and the pinned
  issuer — never native, never a lookalike.
- Amount equals `amount_in` from the anchor response.
- Memo is present, of the type `withdraw_memo_type` names, and its value
  equals `withdraw_memo`. A `hash` memo is base64 in the response and must
  decode to 32 bytes; `id` must be an unsigned 64-bit integer; `text` at most
  28 bytes. A memo of the right value and the wrong type is refused.
- The anchor transaction's `status` is `pending_user_transfer_start` **at the
  time of the read**, and its `id` is the one the sequence started.

Anything else refuses, with the field named. This runs in the build route
before the XDR is returned and again in the submit route against a fresh
anchor read before broadcasting.

### Token handling

The SEP-10 JWT is the user's credential with one anchor for about fifteen
minutes. It is held in memory and `sessionStorage`, keyed by anchor and
account, so a reload mid-KYC does not lose the flow; it is dropped at `exp`.
It is sent to this app's build and submit routes so the server can read the
anchor on the user's behalf, and never logged. It is never sent to any host
other than the anchor that issued it and this app.

### What is deliberately not trusted

- The destination the browser could pass — the server refuses to accept one.
- Any anchor field from configuration or a previous withdrawal.
- The `postMessage` callback from the popup: treated as a hint to poll now,
  never as the fact that the withdrawal is ready.
- `SIGNING_KEY` from the network alone: checked against the pinned value.
- The agent: `thenVenue` must name an anchor in the registry, or the follow-on
  is downgraded to `none` and the swap stands.

## Components

### New

| File                                  | Purpose                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/offramp/anchors.ts`              | The allowlist: id, display name, home domain, pinned `SIGNING_KEY`, which assets it withdraws. Two entries. `anchorStatusUrl()` for where the user sees the anchor's side of a withdrawal.                                                                                |
| `lib/offramp/toml.ts`                 | Fetches `/.well-known/stellar.toml`, parses the four fields needed, verifies the key against the pin. Server-side, cached per process.                                                                                                                                    |
| `lib/offramp/sep10.ts`                | Fetches the challenge, runs the seven checks above, hands the envelope to the wallet adapter, posts the signed envelope back, returns the JWT with its `exp`. Client-side because Freighter is.                                                                           |
| `lib/offramp/sep24.ts`                | `/info` (limits and fees), `POST /transactions/withdraw/interactive`, `GET /transaction`. Typed status enum transcribed from the spec. Plain `fetch`, injectable. Usable from both sides: the client polls, the server reads for the assertion.                           |
| `lib/offramp/build-payment.ts`        | Builds the single-operation payment from an anchor transaction; `assertOfframpPayment`. Mirrors [build-soroban.ts](../../../apps/dapp/lib/swap/build-soroban.ts) in shape, including reading the XDR back to assert on what will be signed rather than what was intended. |
| `lib/offramp/memo.ts`                 | The three memo types, each way. Small, and the place where `hash` is decoded from base64 and checked for 32 bytes.                                                                                                                                                        |
| `app/api/offramp/build/route.ts`      | Takes `{account, anchor, transactionId, authToken}`, reads the anchor, refuses unless `pending_user_transfer_start`, builds, asserts, returns `{xdr, destination, memo, memoType, amount}` so the review card shows what the server read.                                 |
| `app/api/offramp/submit/route.ts`     | Takes the signed XDR, re-reads the anchor, re-asserts, broadcasts, returns the hash.                                                                                                                                                                                      |
| `hooks/use-offramp-session.ts`        | Owns the JWT and the anchor transaction for one withdrawal: authenticate, start interactive, open the popup, poll, surface status.                                                                                                                                        |
| `components/intents/offramp-card.tsx` | The withdrawal's own state: "Complete verification with the anchor" with a button to reopen the popup, then the payment review showing destination and memo as read by the server, then the anchor's post-payment status.                                                 |

### Extended

- `lib/parse-compound.ts` — `FollowOnKind` becomes `'lend' | 'offramp'`.
  Offramp phrasing: _to my bank_, _cash out_, _off-ramp_ / _offramp_, _to
  fiat_, _withdraw to_, _send the dollars_. Venue phrasing: _moneygram_,
  _testanchor_ / _test anchor_. An `OfframpOnlyIntent` beside
  `SupplyOnlyIntent`, for "withdraw 5 USDC to my bank" with no trade first.
- `hooks/use-sequence.ts` — a `SwapThenOfframp` request beside `SwapThenLend`,
  and the phases a withdrawal needs between step one settling and step two
  being buildable: `authenticating`, `anchor-interactive` (popup open,
  polling), `anchor-ready` (buildable). Step two's builder calls
  `/api/offramp/build` instead of `/api/lend/build`; step two's submit calls
  `/api/offramp/submit`. Step two's `positionUrl` is the anchor's
  `more_info_url`.
- `lib/agents/tool-schema.ts` — `thenAction` enum gains `'offramp'`;
  validation context gains `offrampVenueIds`; an offramp naming an unknown
  anchor downgrades to `none` exactly as an unknown lending venue does.
- `lib/agents/strategies.ts` — the brief learns the third follow-on, that it
  costs a second signature _and_ a verification step with the anchor, and
  that anchor limits are given in the market context and not to be recalled.
- `lib/agents/brain.ts`, `lib/agents/market-context.ts` — `offramps:
{venue, asset, minAmount, maxAmount, feeEnabled}[]` read live from each
  anchor's `/info`, absent on chains with no anchor.
- `lib/venues.ts` — `moneygram` and `testanchor` as venues with `integration:
'executes'`, category `offramp`.
- `lib/chat-history.ts` — a settled offramp records the anchor id, the
  anchor's transaction id and `more_info_url`, so Open Positions can show the
  anchor's status after the on-chain payment is done.
- `components/intents/intent-chat.tsx` — an offramp branch beside the lend
  branch where `sequence.prepare` is called.

## Data flow

**"Sell 60 XLM and send the dollars to my bank"**

1. Parser splits at _and_; head is `market_sell XLM → USDC`; follow-on is
   `{kind: 'offramp', venue: 'testanchor'}` (the default when none named).
2. Market context is built; both anchors' `/info` are read and their USDC
   limits included. The competition runs on the swap. Agents propose routes
   into USDC; validation confirms `thenVenue` is a registered anchor.
3. The user picks an agent. `sequence.prepare({kind: 'swap-then-offramp', …})`
   shows both steps before any signature: _Swap 60 XLM for about 6.4 USDC via
   Soroswap_ and _Withdraw about 6.4 USDC to your bank through the SDF test
   anchor (limit 1–10 USDC)_. The estimate is checked against the anchor's
   limits here, before the first signature, so an order that cannot complete
   is refused while nothing has moved rather than after the swap.
4. Signature one: the swap. Settles; `delivered` is measured from the balance.
5. `authenticating`: SEP-10 challenge, seven checks, Freighter signs a
   sequence-0 transaction, JWT returned.
6. `anchor-interactive`: `POST /transactions/withdraw/interactive` with
   `asset_code: USDC` and `amount: <delivered>`. Popup opens on the returned
   URL. Polling begins at three-second intervals. The card says the anchor is
   collecting verification and offers to reopen the popup.
7. Status reaches `pending_user_transfer_start`. Polling stops.
   `/api/offramp/build` reads the anchor, asserts, returns the XDR and what it
   read. The card shows destination and memo verbatim.
8. Signature two: the payment. `/api/offramp/submit` re-reads, re-asserts,
   broadcasts. Sequence settles with the hash and the anchor's
   `more_info_url`.
9. History records the withdrawal. Open Positions polls the anchor while the
   status is any `pending_*`, shows _completed_ when it is, and shows
   `refunded`, `expired` or `error` plainly if that is what happened.

**"Withdraw 5 USDC to my bank"** runs steps 5–9 with no swap and one
signature.

## Sequence state machine

```
idle → building → review → signing → submitting            (step 1: swap)
     → authenticating → anchor-interactive → anchor-ready   (between steps)
     → building → review → signing → submitting → settled   (step 2: payment)
```

Terminal states that are not `settled`: `stopped` (user declined a later
signature and holds USDC — a normal position), `failed` (with the reason),
and a new `anchor-declined` when the anchor's status becomes `expired`,
`refunded`, `error`, `too_small`, `too_large` or `no_market` before the
payment is sent. That last one is a distinct state because nothing was lost
and the user should hear exactly that.

`anchor-interactive` has no timeout inside the sequence. KYC can take as long
as the anchor wants. The user can close the chat and come back; the JWT and
transaction id survive in session storage, and the card offers to resume.

## Agent vocabulary

`thenAction: 'none' | 'lend' | 'offramp'`, `thenVenue` names the anchor.
Validation: `thenAction: 'offramp'` with a `thenVenue` absent from
`offrampVenueIds` downgrades to `none`; the trade stands. Never an amount —
the follow-on applies to what the previous step delivered.

The brief's addition, in substance: offramping sends the proceeds to a bank
through a named anchor; it is only ever done when the user asked; it costs a
second signature and a verification step with the anchor that the user
completes themselves; the anchor's limits are in the market context and a
proposal outside them will be refused, so say so instead.

## Parser

`FollowOnKind = 'lend' | 'offramp'`. The marker split is unchanged. The
follow-on clause is classified by phrasing lists, offramp first because "put
it in my bank" would otherwise match lending's _put it in_. `OfframpOnlyIntent
{kind: 'offramp-only', asset, amount?, amountIsUsd?, venue}` mirrors
`SupplyOnlyIntent`; the default venue when none is named is `testanchor`
until a mainnet anchor exists, at which point the default becomes a
configuration decision rather than a code one.

Declines rather than guesses: "sell XLM and USDC" is not a sequence; "send
XLM to my friend" names no anchor and no fiat and is not an offramp.

## Error handling

| Situation                                      | Behaviour                                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TOML unreachable or key mismatch               | Anchor reported offline for this session; no auth attempted.                                                                                                                      |
| SEP-10 check fails                             | Refused before the wallet prompt; the failed check is named.                                                                                                                      |
| User closes popup early                        | Polling continues; card offers to reopen. Nothing is lost.                                                                                                                        |
| Anchor status `expired` before payment         | `anchor-declined`; user holds USDC; card says so.                                                                                                                                 |
| Anchor status changes between build and submit | Submit refuses; card explains the anchor changed its mind and offers to rebuild.                                                                                                  |
| Anchor's `amount_in` exceeds the USDC held     | Build refuses before the wallet prompt, naming both figures. The anchor is asked for what was delivered, so this means the anchor adjusted upward; the user decides, not the app. |
| Payment confirms, anchor later `refunded`      | Open Positions shows it; the refund arrives on-chain to the same account.                                                                                                         |
| Swap delivers below anchor minimum             | Said in review _before_ the first signature, from the estimate; said again after, from the measurement; the offramp step is skipped and the user holds USDC.                      |
| Swap delivers above anchor maximum             | Withdraw the maximum, say the remainder stays in the wallet.                                                                                                                      |

## Testing

**Unit, no network:** anchor lookup refuses unknown ids; TOML parse; each
SEP-10 check failing individually (wrong source, seq ≠ 0, expired, first op
sourced elsewhere, bad signature, extra operation); each payment-assertion
field failing individually (wrong destination, wrong asset, wrong issuer,
wrong amount, missing memo, wrong memo type, wrong memo value, two
operations, per-op source, fee bump, anchor status not ready); memo
round-trips for all three types including a hash that is not 32 bytes;
compound parse of every phrasing; offramp-only parse with and without amount;
`thenAction: 'offramp'` downgrade with an unknown venue; the general validator
still refuses `payment`.

**Live, no wallet:** both TOMLs fetch and match the pins; both `/info` return
USDC withdraw; both `/auth` return a challenge that passes all seven checks.
These are the "is the anchor still there" tests, like the contract-existence
tests already in the suite.

**Live, wallet, no money:** SEP-10 through Freighter yields a JWT the anchor
accepts; `withdraw/interactive` returns a URL and id; polling reaches
`pending_user_transfer_start` after the fake KYC.

**Live, money (testnet, ≤ 10 USDC):** the full flow on `testanchor` — one
payment, one hash, anchor status reaching `completed`. Then the same on
MoneyGram testnet.

**The bar:** "Sell 60 XLM and send the dollars to my bank" shows two steps,
signs a swap, completes the anchor's page, signs a payment for the amount the
anchor named to the account and memo it named, and Open Positions shows the
anchor's status through to completed. Two hashes on the explorer, one
withdrawal on the anchor.

## Order of work

1. **Registry, TOML, `/info`.** No wallet. Both anchors verified live.
2. **SEP-10 with Freighter.** Wallet, no money. Every check unit-tested to
   fail on its own.
3. **SEP-24 interactive and polling.** Wallet, no money — funds do not move
   until step 4, which is the property that makes this order safe.
4. **Payment builder, assertion, build and submit routes.** First money:
   an offramp-only withdrawal of a few USDC on `testanchor`.
5. **Offramp-only intent and card.** "Withdraw 5 USDC to my bank" end to
   end, manually driven.
6. **Compound parse, sequence variant, agent vocabulary, live limits in the
   market context.** "Sell X XLM and send the dollars to my bank" through
   the real competition.
7. **History and Open Positions.** Anchor status after the payment.
8. **MoneyGram testnet.** Same flow, second anchor, larger limits.

Steps 1–3 cannot lose money by construction.

## Risks

- **The popup.** `noopener` disables the anchor's `postMessage`; browsers
  block popups not opened from a click. The popup is opened synchronously
  from the user's button press and without `noopener`, and polling is the
  source of truth regardless.
- **KYC pages refuse iframes.** Most set `frame-ancestors`. Popup only; no
  iframe fallback.
- **Testnet resets.** Anchor accounts and the USDC issuer survive resets, but
  the live tests assert reachability rather than trusting the constants —
  the same lesson the oracle addresses taught.
- **`testanchor`'s 10 USDC ceiling.** Fine for proving the path, useless for
  demonstrating a realistic amount. MoneyGram's 2500 is the demo anchor once
  the path is proven.
- **MoneyGram production needs a commercial agreement.** The testnet is
  open; mainnet is not a code change, it is a contract.
- **Anchor `on_hold`.** Compliance review can take days and is not a failure.
  Open Positions must present it as waiting, not as an error.
- **Amount drift.** The spec permits ±10% between quoted and sent amounts;
  this app sends exactly `amount_in` and never rounds up.
- **The agent vocabulary widening again.** Three follow-ons now. If a fourth
  arrives, `thenAction` stays an enum and `thenVenue` a string; what should
  not happen is per-action fields on the proposal.

## Out of scope

- **Onramp (SEP-24 deposit).** Different failure mode — funds arrive from
  outside and the trustline must pre-exist. A separate design.
- **SEP-6** (non-interactive, app-collected KYC). SEP-24 exists so the app
  never holds PII; there is no reason to take that on.
- **SEP-38 quotes** for a fixed fiat amount. Both anchors quote in USDC
  today.
- **Assets other than USDC.**
- **Veil's passkey wallet.** A different feature — replacing Freighter — with
  a stellar-sdk 15 pin to resolve first.
