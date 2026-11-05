import { SENDABLE } from '../chains/recipient'
import { chainModule } from '../chains/registry'
import { SEQUENCE_CASHOUT_CHAINS } from '../chains/sequence'
import type { ChainActionKind, ChainWithActions } from '../chains/types'
import { cashOutPrompt } from '../weave/corridors'

/**
 * What Intent does, written down once.
 *
 * The orchestrator answers questions about the app from this sheet and from
 * nothing else. A model left to describe a product from its own idea of one will
 * promise features it lacks, so every claim it may make about Intent is here,
 * and the prompt forbids the rest.
 *
 * Server only: it reads the chains' venues, and whether a chain has any can turn
 * on a secret. Its one importer is the orchestrator, which only an API route runs.
 */

const SWAP_RACED =
  'Swap: trade one asset for another at the market price, or place a limit order at a price you name. Agents compete to propose the best route; you review it and sign in your wallet.'
const SWAP_RACED_OFF_STELLAR =
  'Swap: trade one asset for another at the market price. Agents compete to propose the best route; you review it and sign in your wallet.'
const SWAP_DIRECT =
  'Swap: trade one asset for another at the market price. You review it and sign in your wallet.'

const COMMON = [
  'Accumulate: spread the buying of an asset over time instead of all at once.',
  'Hedge or rebalance: move exposure from one asset into another.',
  'Send: send an asset such as USDC or XLM to another account or to a name like deon.xlm. You review it and sign in your wallet.',
]

const STELLAR_ONLY = [
  'Lend: put an asset you already hold into a lending pool (Blend, and DeFindex when available) to earn yield, with no trade.',
  'Borrow and repay: done from your position in the History tab, where you can see what it can support and the price at which it would be liquidated. Not run from the chat.',
  'Cash out: send USDC or XLM to a Nigerian bank account, paid in naira, through an anchor. A form collects the bank details. Mainnet only.',
  'Leveraged positions: open a long or short on an asset with leverage, for example "long XLM 10x with 50 USDC".',
]

const NATIVE_NOT_SENT: Record<string, string> = {
  solana: "Native SOL can't be sent yet; USDC and the listed tokens can.",
  sui: "Native SUI can't be sent yet; USDC and the listed tokens can.",
  near: "Native NEAR can't be sent yet; USDC and the listed tokens can.",
}

export const OWN_TOKEN: Record<string, string> = {
  solana: 'SOL',
  sui: 'SUI',
  near: 'NEAR',
  avalanche: 'AVAX',
  monad: 'MON',
}

/** Solana, Sui and NEAR list every token a wallet holds. Avalanche and Monad can only read the ones Intent knows. */
function balanceLine(chain: string): string {
  const readsAll = chain === 'solana' || chain === 'sui' || chain === 'near'
  return readsAll
    ? 'Balance: ask what you hold and the wallet is listed token by token, every token it holds.'
    : 'Balance: ask what you hold and the wallet is listed token by token, the tokens Intent knows on this chain.'
}

const NOTHING_RUNS = 'Nothing can be swapped, supplied or staked on this chain right now.'

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join('\n')
}

/** The facts about Intent that apply on a chain, one per line. */
export function capabilitySheet(chain: string): string {
  if (chain === 'stellar') {
    return bullets([SWAP_RACED, ...COMMON, ...STELLAR_ONLY])
  }
  const venues = chainModule(chain)?.venues
  if (venues === undefined) return `- ${SWAP_DIRECT}`

  // Off Stellar only what the chain's own venues can do is claimed: accumulate and hedge are
  // Stellar's, and the chat reads swap, supply, stake, send and a swap followed by one of them.
  // A race needs a venue that can quote, so a kind with none is never promised one.
  const offered = (kind: ChainActionKind): boolean => venues.some((v) => v.kinds.includes(kind))
  const raced = (kind: ChainActionKind): boolean =>
    venues.some((v) => v.kinds.includes(kind) && v.quote !== undefined)
  const lines: string[] = []
  if (offered('swap')) lines.push(raced('swap') ? SWAP_RACED_OFF_STELLAR : SWAP_DIRECT)
  if (offered('supply')) {
    lines.push(
      `Supply: put an asset you hold into a lending or earn venue to earn yield. ${raced('supply') ? 'Agents compete to propose the best venue; you' : 'You'} review it and sign in your wallet.`
    )
  }
  if (offered('stake')) {
    lines.push(
      `Stake: stake an asset for a staking token. ${raced('stake') ? 'Agents compete to propose the best venue; you' : 'You'} review it and sign in your wallet.`
    )
  }
  if (offered('withdraw')) {
    lines.push(
      'Withdraw: take an asset back out of a lending or earn venue, naming the venue, for example "withdraw 25 USDC from Aave". You review it and sign in your wallet.'
    )
  }
  if (offered('unstake')) {
    lines.push(
      'Unstake: turn a staking token back into the asset, for example "unstake 1 sSUI". Some venues pay later or charge a fee, and the card says which. You review it and sign in your wallet.'
    )
  }
  if (offered('borrow')) {
    lines.push(
      'Borrow and repay: borrow against collateral already supplied, for example "borrow 25 USDC on Aave", and repay it with "repay 25 USDC on Aave". A loan can be liquidated. You review it and sign in your wallet.'
    )
  }
  if (offered('stream')) {
    lines.push(
      'Stream: pay someone over time, for example "stream 100 USDC to an address over 30 days". You review it and sign in your wallet, and the person paid withdraws what has streamed.'
    )
  }
  if (offered('invoice')) {
    lines.push(
      'Invoice: bill an address on chain, for example "invoice an address 100 USDC due 2027-01-31", and pay one with "pay invoice 12 with 100 USDC". You review it and sign in your wallet.'
    )
  }
  const sendable = SENDABLE[chain as ChainWithActions]
  if (offered('send') && sendable !== undefined) {
    lines.push(
      `Send: send ${sendable.join(', ')} to an address on this chain. You review it and sign in your wallet. ${NATIVE_NOT_SENT[chain] ?? ''}`.trim()
    )
  }
  if (lines.length === 0) return bullets([NOTHING_RUNS])

  if (offered('swap')) {
    const own = OWN_TOKEN[chain] ?? 'SOL'
    const cashesOut =
      (SEQUENCE_CASHOUT_CHAINS as readonly string[]).includes(chain) && cashOutPrompt(chain) !== ''
    if (cashesOut) {
      lines.push(
        `Swap then cash out: swap into USDC and pay it to a bank or mobile money account as one request, for example "swap 5 ${own} to USDC then cash out". You sign the swap, then start the cash-out yourself.`
      )
    }
    if (offered('supply')) {
      lines.push(
        `Swap then deposit: after a swap, put what arrived into a lending or earn venue, for example "swap 5 ${own} to USDC then deposit". You sign the swap, then the deposit.`
      )
    }
    if (offered('send')) {
      lines.push(
        `Swap then send: after a swap, send what arrived to an address you type, for example "swap 5 ${own} to USDC then send to an address". The address must be typed by you in full.`
      )
    }
    if (chain === 'near') {
      lines.push(
        "Cash out does not run from NEAR: Weave's NEAR deposits aren't working yet. Stake after a swap is not available on NEAR, since a swap to NEAR can arrive as NEAR or wNEAR, so stake what arrives as a second request."
      )
    } else if (chain === 'monad') {
      lines.push('Cash out after a swap does not run on Monad.')
    }
  }
  lines.push('Limit orders are not available off Stellar.', balanceLine(chain))
  return bullets(lines)
}
