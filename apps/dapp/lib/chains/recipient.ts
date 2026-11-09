import { isAddress as isSolanaAddress } from '@solana/kit'
import { isAddress as isEvmAddress, zeroAddress } from 'viem'

import { NEAR_IMPLICIT, NEAR_NAMED } from '../wallet/address'
import { AVALANCHE_TOKENS, EVM_NATIVE_ID, MONAD_TOKENS } from './evm/tokens'
import { NEAR_ACCOUNT } from './near/account'
import { nearTokens } from './near/tokens'
import { SOLANA_TOKENS } from './solana/tokens'
import { recipientName, NAME_TLDS, type RecipientName } from './names/tlds'
import { SUI_TOKENS } from './sui/tokens'
import { withArticle, type ChainWithActions } from './types'

/** Client-safe: the chat refuses from here before any swap, and the server checks again. */

export const SEND_VENUE_NAME = 'Wallet transfer'

const NOTHING_MOVED = 'Nothing was signed or sent.'

const CHAIN_NAME: Record<ChainWithActions, string> = {
  solana: 'Solana',
  sui: 'Sui',
  near: 'NEAR',
  avalanche: 'Avalanche',
  monad: 'Monad',
}

/**
 * What each chain's builder moves as one checked transfer. SOL's table entry is the wrapped mint,
 * so its builder would move wrapped tokens under the name SOL. SUI pays the fee from the coins that
 * builder would spend, and it refuses to touch the gas coin. NEAR's deposit check is USDC only.
 */
export const SENDABLE: Record<ChainWithActions, readonly string[]> = {
  solana: ['USDC', 'USDT', 'JitoSOL', 'ONyc'],
  sui: ['USDC', 'USDT', 'USDsui'],
  near: ['USDC', 'NEAR'],
  avalanche: ['AVAX', 'USDC', 'USDT'],
  monad: ['MON', 'USDC', 'USDT0'],
}

const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/
const SUI_ZERO = /^0x0{64}$/
const SOLANA_ZERO = '11111111111111111111111111111111'
const NEAR_ZERO = '0'.repeat(64)

const EVM_CONTRACTS = [...AVALANCHE_TOKENS, ...MONAD_TOKENS]
  .filter((token) => token.id !== EVM_NATIVE_ID)
  .map((token) => token.id.toLowerCase())

/** The package each coin type lives in. No one holds anything at a package's address. */
const SUI_PACKAGES = SUI_TOKENS.map((token) => {
  const hex = (token.id.split('::')[0] as string).replace(/^0x/, '')
  return `0x${hex.padStart(64, '0').toLowerCase()}`
})

/**
 * Whether money can be sent to this address on this chain, exactly as typed. An EVM address may be
 * all lower case, which carries no checksum, but one with mixed case must pass its checksum: a
 * wrong one means a typo, and a typo here can't be undone. Zero addresses and the token contracts
 * this app knows are refused, since funds sent to either are gone. A name is never an address, even
 * where it fits the shape: `ada.sol` is a well-formed NEAR account, and paying that would be a guess.
 */
export function isValidRecipient(chain: ChainWithActions, address: string): boolean {
  if (recipientName(address) !== undefined) return false
  switch (chain) {
    case 'solana':
      return (
        isSolanaAddress(address) &&
        address !== SOLANA_ZERO &&
        !SOLANA_TOKENS.some((token) => token.id === address)
      )
    case 'sui':
      return (
        SUI_ADDRESS.test(address) &&
        !SUI_ZERO.test(address) &&
        !SUI_PACKAGES.includes(address.toLowerCase())
      )
    case 'near':
      return (
        NEAR_ACCOUNT.test(address) &&
        (NEAR_IMPLICIT.test(address) || NEAR_NAMED.test(address)) &&
        address !== NEAR_ZERO &&
        !nearTokens.some((token) => token.id === address)
      )
    case 'avalanche':
    case 'monad':
      return (
        isEvmAddress(address, { strict: true }) &&
        address.toLowerCase() !== zeroAddress &&
        !EVM_CONTRACTS.includes(address.toLowerCase())
      )
  }
}

function isSameAccount(a: string, b: string): boolean {
  return a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The sentence for a name this chain can't read, or nothing. Asked with no read at all. */
function nameRefusal(chain: ChainWithActions, typed: RecipientName): string | undefined {
  const { name } = typed
  if (!NAME_TLDS[chain].includes(typed.tld)) {
    const home = CHAIN_NAME[typed.chain]
    const here = CHAIN_NAME[chain]
    return `${name} is ${withArticle(home)} name, and this is on ${here}, so it can't be read here. Switch to ${home}, or use ${withArticle(here)} address. ${NOTHING_MOVED}`
  }
  if (!typed.readable) {
    return `${name} can't be read as a name here. Use the wallet address instead. ${NOTHING_MOVED}`
  }
  if (typed.sub) {
    return `${name} is a subname, and those can't be paid by name here. Use the wallet address instead. ${NOTHING_MOVED}`
  }
  return undefined
}

/**
 * The sentence for a send that can't go, or nothing. `symbol` and `account` are left out where they
 * aren't known yet, and the check runs again where they are. A name its chain can read passes here,
 * and the same check runs again on the address it reads to, before anything is built.
 */
export function sendRefusal(
  chain: ChainWithActions,
  symbol: string | undefined,
  recipient: string,
  account?: string
): string | undefined {
  const name = CHAIN_NAME[chain]
  const typed = recipientName(recipient)
  if (typed !== undefined) {
    const refusal = nameRefusal(chain, typed)
    if (refusal !== undefined) return refusal
  } else {
    if (!isValidRecipient(chain, recipient)) {
      return `That is not an address that can receive on ${name}, so I won't send to it. Check the address. ${NOTHING_MOVED}`
    }
    if (account !== undefined && isSameAccount(recipient, account)) {
      return `That address is your own wallet, so there is nothing to send. ${NOTHING_MOVED}`
    }
  }
  if (symbol === undefined) return undefined
  const wanted = symbol.trim().toUpperCase()
  if (SENDABLE[chain].some((listed) => listed.toUpperCase() === wanted)) return undefined
  return `Sending ${symbol} isn't available on ${name} yet. You can send ${SENDABLE[chain].join(', ')}. ${NOTHING_MOVED}`
}
