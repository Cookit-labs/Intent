import type { ChainToken, SignedPayload, SigningPayload, SubmitResult } from '../chains/types'

/**
 * The chains with a deposit path written for Weave. Only USDC, on every one of them. Weave has not
 * paid out a real order in this app from any of them, and `closedCashoutReply` refuses some.
 */
export type CashoutChain = 'stellar' | 'solana' | 'avalanche' | 'sui' | 'near'

export const CASHOUT_CHAINS: readonly CashoutChain[] = [
  'stellar',
  'solana',
  'avalanche',
  'sui',
  'near',
]

/** Above this, an order is refused rather than offered. */
export const MAX_COST_PERCENT = 5

export function isCashoutChain(value: string): value is CashoutChain {
  return (CASHOUT_CHAINS as readonly string[]).includes(value)
}

const MOVE_THEN_CASH_OUT =
  'To cash out, move your USDC to Solana, Avalanche or Sui with a bridge you trust, connect that wallet here, and cash out from there. Weave has not paid out a real order in this app yet, so try a small amount first. Nothing was signed or sent.'

/**
 * Chains refused before any form opens. `weave-cashout-gaps.live.test.ts` rechecks the reasons.
 *
 * NEAR: a live order on 2026-11-04 answered `NEAR Intents 400: Incorrect depositMode`. 1Click says
 * exactly that to `depositMode: MEMO` on a chain with no memo, and Weave's docs list NEAR as needing
 * one, so Weave probably asks for the wrong mode. Open it only once an unfunded order comes back
 * with a deposit address and no memo.
 *
 * Monad: not on Weave's `/assets`, and no order has been tried. Paying Weave's address on another
 * chain through 1Click is not a way round: 1Click counts delivery as done, so a delivery after
 * Weave's order expired, or a refund from Weave, has no documented way back to the person on Monad.
 */
const CLOSED_CASHOUTS = new Map<string, string>([
  [
    'near',
    `Cash-outs don't run from NEAR right now, because Weave can't open an order for a NEAR deposit. ${MOVE_THEN_CASH_OUT}`,
  ],
  [
    'monad',
    `Cash-outs don't run from Monad yet, because Weave doesn't list Monad for deposits. ${MOVE_THEN_CASH_OUT}`,
  ],
])

/** What to tell someone cashing out on this chain, or nothing if a cash-out can start here. */
export function closedCashoutReply(chain: string): string | undefined {
  return CLOSED_CASHOUTS.get(chain)
}

const WEAVE_CHAIN_ID: Record<CashoutChain, string> = {
  stellar: 'STELLAR',
  solana: 'SOLANA',
  avalanche: 'AVALANCHE',
  sui: 'SUI',
  near: 'NEAR',
}

export function weaveChainId(chain: CashoutChain): string {
  return WEAVE_CHAIN_ID[chain]
}

/** The asset Weave is told the deposit is in. */
export function weaveAssetKey(chain: CashoutChain): string {
  return `crypto:${WEAVE_CHAIN_ID[chain]}:USDC`
}

/**
 * One deposit: what the stored order says must be paid. Read from the database on
 * every use, never from the browser.
 */
export interface DepositExpectation {
  account: string
  depositAddress: string
  /** Absent when the order has no memo. Refused by chains that cannot carry one. */
  memo: string | undefined
  /** The token in display units. */
  amount: string
  /**
   * What to transfer. Absent means USDC, which is all a Weave order ever sends. Solana and Sui
   * move the token named, Avalanche refuses any but USDC, and Stellar and NEAR are never given one.
   */
  token?: ChainToken | undefined
}

/**
 * What each chain supplies for a deposit. `assertSafe` is the check that matters:
 * it reads the payload back and admits only one transfer of the expectation's token, USDC when
 * none is named, from `account` to the order's deposit address for exactly the order's amount,
 * and it throws `ChainActionRefused` on anything else.
 */
export interface DepositChain {
  chain: CashoutChain
  /** Places USDC has on this chain. An order amount with more is refused. */
  usdcDecimals: number
  /** Whether a memo can be sent. An order with a memo on any other chain is refused. */
  supportsMemo: boolean
  isAccount: (address: string) => boolean
  isDepositAddress: (address: string) => boolean
  /** USDC this account holds, in base units. Throws when the chain can't be read. */
  usdcBalance: (account: string) => Promise<bigint>
  build: (expectation: DepositExpectation) => Promise<SigningPayload>
  assertSafe: (payload: SigningPayload, expectation: DepositExpectation) => void
  /**
   * Checks what came back against `expectation` again, then sends it, or for wallets
   * that send for themselves confirms on-chain that it paid the deposit. A transfer
   * that may have landed is `{ ok: false, pending: true }`, never a failure.
   */
  submit: (signed: SignedPayload, expectation: DepositExpectation) => Promise<SubmitResult>
}
