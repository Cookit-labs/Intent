# Naira off-ramp, two-leg path: XLM to USDC, then USDC to naira

Status: draft for review. Builds on PR #86 (direct XLM to naira, merged).

## Goal

Let a user turn XLM into naira in a bank account in two legs: the agents compete to swap the XLM to USDC, then the USDC is paid to a Linq deposit address that pays naira out. The existing direct path (XLM straight to Linq) stays.

## Why a second path

- The agent race gets real work on this intent: route competition on the swap.
- The deposit is a stable dollar amount, so what the bank receives is known from the USDC delivered rather than floating with XLM.

Cost: two signatures, plus swap fees and slippage. Direct XLM is one signature.

## Path selection

One form, one visible toggle: **Send XLM directly** or **Convert to USDC first**.

- Wording preselects it: "swap" or "convert" preselects convert-first; "cash out", "withdraw" or "offramp" preselects direct.
- The user can switch before reviewing. The toggle shows what each costs: one signature or two.
- Nothing about the choice is hidden. The review card states the path.

## User flow (convert-first)

1. **Form.** Amount, bank, account number, holder looked up from the bank. As today, plus the toggle. No order exists yet.
2. **Swap leg.** The competition runs for XLM to USDC at the form's amount. The user picks an agent and signs the swap, as in any swap.
3. **Order.** When the swap settles, the delivered USDC is measured from the account's balance change. The server creates the Linq order for that amount and stores it.
4. **Review, with final numbers.** The card shows the USDC being sent, the naira the bank receives, the rate and the holder. Slippage is already in these figures, and the user sees them before the second signature.
5. **Payment leg.** The server builds a USDC payment to the order's deposit address, asserted against the stored order. The user signs, the server re-asserts and submits, and the card tracks the payout as now.

## Components

| Piece | Change |
| --- | --- |
| `lib/linq/client.ts` | `createOrder` takes `coin: 'xlm' \| 'usdc'`. USDC orders go by `amountStableCoin` (the delivered amount), still `chain: 'stellar'` and `manualDeposit: true`. The response check requires the coin asked for. |
| `lib/naira/build-payment.ts` | A USDC variant: native-or-USDC asset, and USDC is admitted only with the app's USDC code and issuer. Same one-operation, destination and exact-amount assertion. |
| `lib/naira/orders.ts` and `011_naira_orders_coin.sql` | Add `coin TEXT NOT NULL DEFAULT 'xlm'`. The amount column keeps its historical name `amount_xlm` and holds the amount of `coin`; renaming is deferred. |
| `POST /api/naira/orders` | Accepts `coin` and, for USDC, `amountStableCoin`. Also checks that the amount does not exceed the account's current USDC balance and is within the cap. |
| `build` and `submit` routes | Read `coin` from the stored order and use the matching builder and assertion. |
| `hooks/use-sequence.ts` | New kind `swap-then-naira`, beside `swap-then-offramp`. Step 1 is the swap; between steps it creates the order from the measured delivery; step 2 is the USDC payment through the naira routes. |
| Intent reader | "swap/convert $N of XLM to naira" goes to the form with convert-first preselected. |
| `NairaPayoutCard` | Adds the toggle and, for convert-first, hands the filled form to the sequence instead of creating an order itself. |

## Failure handling

| Failure | What the user is left with | Response |
| --- | --- | --- |
| Swap rejected at signature | Nothing changed | Back to review |
| Swap fails | Nothing changed | Said plainly; retry |
| Swap settles, order creation fails or times out | USDC in their account | "Your XLM is now USDC." Retry with the same idempotency key, or keep the USDC. Never a second order. |
| Linq refuses the bank or amount | USDC in their account | Show Linq's message; edit and retry |
| Second signature declined or ignored | USDC in their account, an order that expires in 10 minutes | Said as such; "Pay now" while the order lives, otherwise create a new order |
| Order expires | USDC in their account | Said as expired; start again from the payout step |

In every case the account never holds anything but XLM or USDC it already owned. No leg leaves money in an intermediate place the user cannot see.

## Security

- The Linq key and webhook secret stay server-side. Unchanged.
- The destination and amount of the payment come from the stored order, never from the browser, and are asserted against the signed bytes at submit. USDC is admitted only with the app's code and issuer, matching the anchor path.
- The delivered amount is reported by the client, since Horizon does not expose a router's output. That is safe because the user pays from their own balance: the server refuses an amount above the current USDC balance, and an amount that is too low only pays the user less.
- The holder name is looked up server-side at order creation, as today.
- The refund address is the user's own account, which must hold a USDC trustline. The server confirms this with Linq's trustline check; an unknown answer (503) is accepted, as Linq documents.
- The per-payout cap applies to the naira amount. The account number stays only in the order row.

## Testing

- Unit: Linq client in USDC mode; USDC payment builder and assertion (wrong issuer, wrong asset, wrong amount, extra operation); intent routing; toggle preselection from wording.
- Sequence: swap-then-naira with a faked swap and a faked Linq, covering each row of the failure table.
- Server: order creation refuses an amount above the USDC balance and over the cap.
- Manual: one real run with a small amount (a few hundred naira) on mainnet before the PR merges.

## Out of scope

- Naira payouts from assets other than XLM and USDC.
- Currencies other than naira.
- Wiring the chat clarifier. The form replaces it for this intent.
- Renaming `amount_xlm`.

## Open questions

1. Linq's minimum order size is not documented. The first live test sets the floor; until then the form has none.
2. Does a USDC deposit sized to more than two decimals reconcile cleanly? `manualDeposit: true` pays actual deposit times the locked rate, so it should, but the first live test should use a non-round amount.
