import { createHmac } from 'node:crypto'

import { TransactionDataBuilder } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'

import { walletSends } from '../weave/cashout-view'
import { nearDeposit } from '../weave/deposit/near'
import { assertDepositIsNotTokenAccount, solanaDeposit } from '../weave/deposit/solana'
import { suiDeposit } from '../weave/deposit/sui'
import type { DepositChain, DepositExpectation } from '../weave/types'
import { evmDeposit } from './evm/deposit'
import { EVM_HASH } from './evm/submit'
import { EVM_CHAINS, evmExplorerUrl, type EvmChain } from './evm/tokens'
import { NEAR_ACCOUNT, NEAR_TX_HASH } from './near/account'
import { isRegistered } from './near/rpc'
import { assertTokenTransferSafe } from './near/safety'
import { buildDepositTransaction } from './near/swap'
import { explorerUrl as nearExplorerUrl, formatUnits, nearTokens } from './near/tokens'
import { sameProof, secret } from './oneclick-origin'
import { isValidRecipient, SEND_VENUE_NAME, sendRefusal } from './recipient'
import { explorerUrl as solanaExplorerUrl, feePayerSignature } from './solana/submit'
import { SOLANA_TOKENS } from './solana/tokens'
import { SUI_TOKENS } from './sui/tokens'
import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type ChainWithActions,
  type PreparedAction,
  type SignedPayload,
  type SigningPayload,
  type SubmitInput,
  type SubmitResult,
} from './types'

/**
 * Moves one token to an address a person typed. It can't be undone, so nothing here decides what a
 * transfer is. Each chain's deposit builder builds and checks exactly one, as it does for a Weave
 * order and a 1Click swap, with the recipient standing where the deposit address does.
 *
 * The browser carries `context` between prepare and submit, so the recipient, token and amount in
 * it are believed only once `readIssued` proves this server wrote them. With no secret no proof can
 * be issued or read, so the module offers no such venue and everything here refuses.
 */

export const SEND_VENUE_ID = 'send'
export const SEND_NOTE = "Transfers can't be undone. Check the address."

const NOTHING_MOVED = 'Nothing was signed or sent.'
const UNAVAILABLE = `Sending isn't available here right now. ${NOTHING_MOVED}`
/** Both can be said after the wallet has signed, at submit, where only "sent" is still true. */
const NOT_ISSUED = "This transfer's details are not what this app issued. Nothing was sent."
const NOT_THE_TRANSFER =
  'This is not the transfer that was asked for, so it was stopped. Nothing was sent.'
const NOT_SENT = 'This transfer was not sent, so nothing left your wallet. You can try again.'

const SOLANA_RENT_NOTE =
  "If this address has no account for this token yet, your wallet also pays about 0.00204 SOL in rent to open one, and you don't get it back."

/** Inside the submit route's 60 seconds, leaving room to answer. */
const CONFIRM_WAIT_MS = 50_000

/** Each chain's builder, and what it takes to follow a transfer on that chain. */
interface Mover {
  family: 'solana' | 'sui' | 'near' | 'evm'
  tokens: readonly ChainToken[]
  deposit: Pick<DepositChain, 'build' | 'assertSafe' | 'submit'>
  /** What only the chain can say about the receiver. Asked before a swap as well as at the build. */
  assertReceiver?: (recipient: string, token: ChainToken) => Promise<void>
  assertFunds?: (account: string, token: ChainToken, amount: string) => Promise<string[]>
  notes?: readonly string[]
  hashOf: (signed: SignedPayload) => string | undefined
  explorerUrl: (hash: string) => string
}

/** What the network's sentences say that isn't true of a transfer. */
const OTHER_WORDS = /\b(?:trades?|prices?|swaps?|orders?|deposits?)\b/i

/** The builders speak of orders and swaps. What is on this path is said for a transfer instead. */
function sendWords(text: string): string {
  return text
    .replace(/This order[’']s deposit address/g, 'That address')
    .replace(/This order[’']s amount/g, 'This amount')
    .replace(/this order[’']s amount/g, 'this amount')
    .replace(/\b(?:the|this) swap\b/g, 'this transfer')
}

async function inSendWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (e) {
    if (e instanceof ChainActionRefused) throw new ChainActionRefused(sendWords(e.message))
    throw e
  }
}

const NEAR_USDC = tokenBySymbol(nearTokens, 'USDC') as ChainToken

/**
 * The shared check with the receiver's shape opened to named accounts, then bound exactly, in one
 * action on USDC. A send never pays for anyone's storage, so `storage_deposit` can't pass here.
 */
function assertNearSend(payload: SigningPayload, expectation: DepositExpectation): void {
  assertTokenTransferSafe(payload, expectation.account, NEAR_ACCOUNT)
  if (payload.family !== 'near') throw new ChainActionRefused(NOT_THE_TRANSFER)
  const transaction = payload.transactions[0]
  const args = transaction?.actions[0]?.params.args
  if (
    transaction?.receiverId !== NEAR_USDC.id ||
    transaction.actions.length !== 1 ||
    args?.['receiver_id'] !== expectation.depositAddress ||
    args?.['amount'] !== toBaseUnits(expectation.amount, NEAR_USDC.decimals)
  ) {
    throw new ChainActionRefused(NOT_THE_TRANSFER)
  }
}

const NEAR_MOVER: Mover = {
  family: 'near',
  tokens: nearTokens,
  deposit: {
    build: async (expectation) => {
      const transaction = await buildDepositTransaction(
        NEAR_USDC,
        expectation.account,
        expectation.depositAddress,
        toBaseUnits(expectation.amount, NEAR_USDC.decimals)
      )
      const payload: SigningPayload = { family: 'near', transactions: [transaction] }
      assertNearSend(payload, expectation)
      return payload
    },
    assertSafe: assertNearSend,
    submit: nearDeposit.submit,
  },
  assertReceiver: async (recipient) => {
    let registered: boolean
    try {
      registered = await isRegistered(NEAR_USDC.id, recipient)
    } catch {
      throw new ChainActionRefused(`NEAR's network could not be read just now. ${NOTHING_MOVED}`)
    }
    if (!registered) {
      throw new ChainActionRefused(
        `${recipient} is not registered with USDC on NEAR, so this transfer would fail. They need to register with the token first. ${NOTHING_MOVED}`
      )
    }
  },
  hashOf: (signed) => {
    const hash = signed.family === 'near' ? signed.hashes[signed.hashes.length - 1] : undefined
    return hash !== undefined && NEAR_TX_HASH.test(hash) ? hash : undefined
  },
  explorerUrl: nearExplorerUrl,
}

const SOLANA_MOVER: Mover = {
  family: 'solana',
  tokens: SOLANA_TOKENS,
  deposit: solanaDeposit,
  assertReceiver: (recipient, token) =>
    assertDepositIsNotTokenAccount(recipient, token, { refusePrograms: true }),
  notes: [SOLANA_RENT_NOTE],
  hashOf: (signed) =>
    signed.family === 'solana' ? feePayerSignature(signed.signedTransaction) : undefined,
  explorerUrl: solanaExplorerUrl,
}

const SUI_MOVER: Mover = {
  family: 'sui',
  tokens: SUI_TOKENS,
  deposit: suiDeposit,
  hashOf: (signed) => {
    if (signed.family !== 'sui') return undefined
    try {
      return TransactionDataBuilder.getDigestFromBytes(fromBase64(signed.transaction))
    } catch {
      return undefined
    }
  },
  explorerUrl: (hash) => `https://suiscan.xyz/mainnet/tx/${hash}`,
}

function evmMover(chain: EvmChain): Mover {
  const deposit = evmDeposit(chain)
  return {
    family: 'evm',
    tokens: EVM_CHAINS[chain].tokens,
    deposit,
    assertFunds: deposit.assertFunds,
    hashOf: (signed) =>
      signed.family === 'evm' && EVM_HASH.test(signed.hash) ? signed.hash : undefined,
    explorerUrl: (hash) => evmExplorerUrl(chain, hash),
  }
}

function moverFor(chain: ChainWithActions): Mover {
  if (chain === 'solana') return SOLANA_MOVER
  if (chain === 'sui') return SUI_MOVER
  if (chain === 'near') return NEAR_MOVER
  return evmMover(chain)
}

interface Issued {
  recipient: string
  /** The token's id. */
  token: string
  /** Base units. */
  amount: string
}

/**
 * Proves a transfer came from this server, for this chain and account. Every field that decides
 * where funds go is signed. The prefix keeps this from passing as a 1Click or session signature,
 * which share the secret.
 */
function proofOf(chain: ChainWithActions, account: string, issued: Issued, key: string): string {
  const message = JSON.stringify([chain, account, issued.token, issued.amount, issued.recipient])
  return createHmac('sha256', key).update(`chain-send:${message}`).digest('base64url')
}

/** A venue that moves one token to an address, or a refusal from whichever check fails first. */
export function createSendVenue(chain: ChainWithActions): ChainVenue {
  const mover = moverFor(chain)

  /** The transfer this server issued, or a refusal. Never returns anything it did not sign. */
  function readIssued(
    account: string,
    context: Record<string, string> | undefined
  ): DepositExpectation {
    const key = secret()
    const recipient = context?.['recipient']
    const tokenId = context?.['token']
    const amount = context?.['amount']
    const proof = context?.['proof']
    if (
      key === undefined ||
      recipient === undefined ||
      tokenId === undefined ||
      amount === undefined ||
      proof === undefined ||
      !sameProof(proof, proofOf(chain, account, { recipient, token: tokenId, amount }, key)) ||
      !isValidRecipient(chain, recipient)
    ) {
      throw new ChainActionRefused(NOT_ISSUED)
    }
    const token = mover.tokens.find((t) => t.id === tokenId)
    if (token === undefined) throw new ChainActionRefused(NOT_ISSUED)
    return {
      account,
      depositAddress: recipient,
      memo: undefined,
      amount: formatUnits(amount, token.decimals, token.decimals),
      token,
    }
  }

  function tokenFor(symbol: string): ChainToken {
    const token = tokenBySymbol(mover.tokens, symbol)
    if (token === undefined) throw new ChainActionRefused(NOT_THE_TRANSFER)
    return token
  }

  function assertSendable(symbol: string, recipient: string | undefined, account: string): string {
    if (recipient === undefined) {
      throw new ChainActionRefused(`A send needs an address to go to. ${NOTHING_MOVED}`)
    }
    const refusal = sendRefusal(chain, symbol, recipient, account)
    if (refusal !== undefined) throw new ChainActionRefused(refusal)
    return recipient
  }

  async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
    const key = secret()
    if (key === undefined) throw new ChainActionRefused(UNAVAILABLE)
    const recipient = assertSendable(request.tokenIn, request.recipient, account)
    const token = tokenFor(request.tokenIn)
    const amount = toBaseUnits(request.amount, token.decimals)
    const expectation: DepositExpectation = {
      account,
      depositAddress: recipient,
      memo: undefined,
      amount: request.amount,
      token,
    }
    const { signing, fundsNotes } = await inSendWords(async () => {
      await mover.assertReceiver?.(recipient, token)
      const notes = (await mover.assertFunds?.(account, token, request.amount)) ?? []
      return { signing: await mover.deposit.build(expectation), fundsNotes: notes.map(sendWords) }
    })
    const issued: Issued = { recipient, token: token.id, amount }
    return {
      venueId: SEND_VENUE_ID,
      venueName: SEND_VENUE_NAME,
      kind: 'send',
      summary: `Send ${request.amount} ${token.symbol} to ${recipient}.`,
      pay: { amount: request.amount, symbol: token.symbol },
      notes: [SEND_NOTE, ...(mover.notes ?? []), ...fundsNotes],
      signing,
      context: { ...issued, proof: proofOf(chain, account, issued, key) },
    }
  }

  /** What came back, against what was issued. The wording stays about a transfer on every path. */
  function assertSafe(
    payload: SigningPayload,
    account: string,
    context?: Record<string, string>
  ): void {
    const expectation = readIssued(account, context)
    try {
      mover.deposit.assertSafe(payload, expectation)
    } catch (e) {
      if (e instanceof ChainActionRefused) throw new ChainActionRefused(NOT_THE_TRANSFER)
      throw e
    }
  }

  /**
   * An answer lacks `pending` only if it proves nothing moved. On Solana and Sui this server is
   * what sends, so a refusal here does. A wallet that sends for itself has sent by now, so nothing
   * said here can prove that: every answer there short of a confirmation is pending.
   */
  async function submit(input: SubmitInput): Promise<SubmitResult> {
    const { account, signed, context } = input
    const sends = walletSends(mover.family)
    const unconfirmed = (): SubmitResult => {
      const hash = signed.family === mover.family ? mover.hashOf(signed) : undefined
      const where = hash === undefined ? "your wallet's activity" : mover.explorerUrl(hash)
      return {
        ok: false,
        pending: true,
        error: `This transfer may have gone out${hash === undefined ? '' : ` as ${hash}`} and isn't confirmed yet. Don't send it again until you've checked ${where}.`,
      }
    }

    if (signed.family !== mover.family) {
      return sends ? unconfirmed() : { ok: false, error: NOT_THE_TRANSFER }
    }
    let expectation: DepositExpectation
    try {
      expectation = readIssued(account, context)
    } catch (e) {
      if (!(e instanceof ChainActionRefused)) throw e
      return sends ? unconfirmed() : { ok: false, error: e.message }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), CONFIRM_WAIT_MS)
    })
    try {
      const result = await Promise.race([mover.deposit.submit(signed, expectation), limit])
      if (result === undefined) return unconfirmed()
      if (result.ok) return result
      if (result.pending === true || sends) return unconfirmed()
      // A sentence about the fee or the balance says what to do. Only other words are replaced.
      return {
        ok: false,
        error: OTHER_WORDS.test(result.error)
          ? `This transfer did not go through, so your ${expectation.token?.symbol ?? 'funds'} did not move. You can try again.`
          : result.error,
      }
    } catch (e) {
      // A refusal here comes before the builder sends, and may be only a read that failed, so it
      // says what is true of both. Anything else may be after the send.
      return e instanceof ChainActionRefused && !sends
        ? { ok: false, error: NOT_SENT }
        : unconfirmed()
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    id: SEND_VENUE_ID,
    name: SEND_VENUE_NAME,
    kinds: ['send'],
    prepare,
    assertSafe,
    submit,
    assertCanFollow: async ({ tokenIn, recipient }, account) => {
      if (secret() === undefined) throw new ChainActionRefused(UNAVAILABLE)
      const to = assertSendable(tokenIn, recipient, account)
      await inSendWords(async () => mover.assertReceiver?.(to, tokenFor(tokenIn)))
    },
  }
}
