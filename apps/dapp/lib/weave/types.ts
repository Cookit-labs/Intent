import type { SignedPayload, SigningPayload, SubmitResult } from '../chains/types'

/** The chains a person can cash out from through Weave. Only USDC, on every one of them. */
export type CashoutChain = 'stellar' | 'solana' | 'avalanche' | 'sui' | 'near'

export const CASHOUT_CHAINS: readonly CashoutChain[] = [
  'stellar',
  'solana',
  'avalanche',
  'sui',
  'near',
]

export function isCashoutChain(value: string): value is CashoutChain {
  return (CASHOUT_CHAINS as readonly string[]).includes(value)
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
  /** USDC in display units. */
  amount: string
}

/**
 * What each chain supplies for a deposit. `assertSafe` is the check that matters:
 * it reads the payload back and admits only one USDC transfer from `account` to the
 * order's deposit address for exactly the order's amount, and it throws
 * `ChainActionRefused` on anything else.
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
