# USDC to NGN offramp: how Veil does it

Sources: `Miracle656/veil` (mobile client, `docs/NGN_RAILS.md`) and `Miracle656/wraith` (the backend that holds the provider key). Read 2026-10-01. Linq's API shape below is inferred from wraith's client code, not from Linq's own docs.

## Architecture

```
wallet --> wraith /offramp/* --> Linq B2B API --> NGN bank payout
              |                      ^
              +-- Postgres order row |
              +-- /linq webhook -----+  (HMAC-signed)
```

The wallet never talks to Linq. The Linq API key can create orders that pay real naira, so it lives only on the server.

## Linq B2B API (as called by wraith)

| Wraith route                | Linq call                    | Notes                                                                                      |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /offramp/rate`         | `GET /b2b/rate` (no auth)    | Indicative only. Cached 20s because all users share one provider key and its rate limit.   |
| `POST /offramp/verify-bank` | `POST /b2b/verifybank`       | Returns the account name the bank holds. Called before any order exists.                   |
| `GET /offramp/trustline`    | `GET /b2b/stellar/trustline` | Refund-address check. Linq rejects `C...` and muxed `M...`. A 503 resolves to "assume ok". |
| `POST /offramp/orders`      | `POST /b2b/offramp`          | Body forces `chain: "stellar"`, `coin: "usdc"`, `currency: "NGN"`, `manualDeposit: true`.  |
| `GET /offramp/orders/:id`   | `GET /b2b/status?id=`        | Reconciles against the provider on every read.                                             |

Order creation takes exactly one of `amountNGN` or `amountStableCoin`, plus bank account, code, name, account name, `refundAddress`, `customerRef` and `idempotencyKey`. The response carries a one-time Stellar deposit address (trustline already in place), locked rate and status. Orders expire after 10 minutes without a deposit.

Webhook: `order.processing`, `order.completed`, `order.failed`. Signed `X-Linq-Signature: sha256=<hex>` over the raw body, under a secret separate from the API key. The route must use `express.raw()` before any JSON parser.

## Patterns worth copying

1. **Key stays server-side.** Every provider call goes through our backend.
2. **Verify the bank account first.** A bad account name otherwise fails after the USDC has left.
3. **Client-generated idempotency key**, minted once per attempt and reused on retry. Server replays return the same order, and a different wallet with the same key gets 409.
4. **Our own order id and access token.** The provider id never leaves the server. The client gets `ofr_` + 128 bits and an `oft_` bearer token (256 bits, shown once, only the SHA-256 stored). A wrong id and a wrong token both return 404. Only failed lookups count toward the rate limit.
5. **One deadline for a whole operation** (35s, below every client timeout). Retries on 429 and one retry on 5xx share it. A client timeout is never reported as "failed", because the order may exist.
6. **`manualDeposit: true`.** The payout follows what actually arrives, so underpaying is not a loss for the operator.
7. **Persist the row before responding**, so the deposit address cannot be in the user's hands without a record.
8. **Reconcile on read.** Poll the provider and fall back to the local row with `source: "cache"`, because webhooks can be missed.
9. **Normalise provider statuses** for clients (`refunded`, `expired` mapped to terminal "failed" or "timeout" words) and strip the provider's name from user-facing errors.
10. **Client resumes an in-flight order** from a stored id after the user leaves to send the deposit.
11. **Refund address must be a classic G-account**, never a contract wallet.

## Alternative rail: Busha (from Veil's `NGN_RAILS.md`)

Quote (USDC to NGN, bank transfer) then transfer returns a per-transfer deposit address. Production only: the Stellar USDC sell leg returns 503 in sandbox. About 0.59% spread plus a flat ₦107.50 payout fee. Requires a CAC-registered company for KYB. Open questions: deposit memo handling and third-party bank payouts. Not ready to build against.

## Regulatory

Veil's own analysis: routing a real user's crypto to naira via a licensed partner is still "arranging" under ISA 2025 (Second Schedule Part II para 2), with criminal exposure under s.61 and the Chaka precedent. Promotion was what got Chaka restrained. Veil restricts this to closed testing until it has an SEC letter or access to the CBN sandbox. Not legal advice.

## Gaps in Veil's approach (do not copy)

- Mainnet only, no sandbox: every end-to-end test spends real money.
- Single shared provider key means one noisy user can rate-limit everyone.
- No stated per-user limits or KYC step on our side.
- The Linq base URL is a Koyeb default in code and the provider is a small operator. Treat float and availability accordingly.

## Fit with Intent

Intent's current offramp is SEP-24 anchors: `apps/dapp/lib/offramp/` (pinned-key allowlist in `anchors.ts`, field-by-field payment assertion in `build-payment.ts`). Mainnet has no anchor configured. An NGN provider is a different shape (order, deposit address, poll), so it needs its own provider kind beside the anchor path, reusing the same assertion discipline: the deposit destination and amount come from the provider's order, read server-side, and are asserted again before signing.
