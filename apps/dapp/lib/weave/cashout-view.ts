import type { SignedOutcome, SignedPayload, SigningPayload } from '../chains/types'
import { WEAVE_BANK_LOGOS } from './bank-logos'
import { closedCashoutReply, type CashoutChain } from './types'

export const CASHOUT_STATUSES = [
  'waiting',
  'processing',
  'paid',
  'failed',
  'expired',
  'refunded',
] as const

export type CashoutStatus = (typeof CASHOUT_STATUSES)[number]

export interface CashoutOrderView {
  id: string
  chain: string
  status: CashoutStatus
  currency: string
  amount: string
  estimatedDest: string
  institutionName: string
  accountName: string
  accountMask: string
  depositAddress: string
  depositHash?: string | undefined
  expiresAt?: string | undefined
}

export interface CashoutCurrency {
  code: string
  name: string
  symbol: string
  country: string
}

export type InstitutionType = 'bank' | 'mobile_money'

export interface CashoutInstitution {
  name: string
  code: string
  type: InstitutionType
}

export interface CashoutQuote {
  destAmount: string | number
  costPercent: number
  seconds: number
}

export type CashoutPhase =
  | 'form'
  | 'creating'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'tracking'
  /** Sent, or possibly sent, with the outcome not known yet. Not a failure. */
  | 'pending'
  /** A wallet that sends for itself came back without a hash. It may have sent. */
  | 'check'
  | 'failed'

export const DO_NOT_RESEND = 'Do not send it again.'

const PENDING_MESSAGE = `Your wallet may have sent this transfer, and its outcome isn't known yet. ${DO_NOT_RESEND} Check your wallet's activity; this page keeps following the order.`

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Groups the digits and changes none of them: this is what is being paid. */
export function formatUsdc(amount: string): string {
  const [whole = '0', fraction] = amount.split('.')
  return fraction !== undefined ? `${group(whole)}.${fraction}` : group(whole)
}

const CURRENCY_PREFIX: Record<string, string> = {
  NGN: '₦',
  KES: 'KSh ',
  UGX: 'USh ',
  TZS: 'TSh ',
}

/** The way the payout form writes money: "₦4,121.25". */
export function formatPayout(amount: string | number, currency: string): string {
  const value = Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const prefix = CURRENCY_PREFIX[currency]
  return prefix !== undefined ? `${prefix}${value}` : `${value} ${currency}`
}

/**
 * Whether a holder name is one. Outside Nigeria the check can answer a bare "OK"
 * even for a made-up number, as seen live on KES: the account was not confirmed, and
 * saying so is the point, because a wrong number can send the money to a stranger.
 */
export function isRealHolderName(name: string): boolean {
  return name.trim().toUpperCase() !== 'OK'
}

function bankKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * One country's providers in the form the bank picker shows them: A to Z, with the
 * logo the naira form uses for the same bank, or else the one held for that country.
 * Codes stay the provider's, because those are what it pays out on.
 */
export function withBankLogos(
  institutions: readonly CashoutInstitution[],
  known: readonly { name: string; logo?: string | undefined }[],
  currency: string
): { code: string; name: string; logo?: string }[] {
  const logos = new Map<string, string | undefined>()
  for (const [name, slug] of Object.entries(WEAVE_BANK_LOGOS[currency] ?? {})) {
    logos.set(bankKey(name), `/bank-logos/weave/${slug}.webp`)
  }
  for (const bank of known) {
    if (bank.logo !== undefined) logos.set(bankKey(bank.name), bank.logo)
  }
  return [...institutions]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ code, name }) => {
      const logo = logos.get(bankKey(name))
      return logo !== undefined ? { code, name, logo } : { code, name }
    })
}

export function isValidAmount(amount: string): boolean {
  return /^\d+(\.\d{1,6})?$/.test(amount) && /[1-9]/.test(amount)
}

/** Weave's docs don't say how or when a refund runs, and none has run here, so none is promised. */
const REFUND_UNPROVEN =
  "Refunds are Weave's to make and none has run in this app yet, so check your wallet and keep this order."

const STATUS_TEXT: Record<CashoutStatus, string> = {
  waiting: 'Waiting for your deposit to be confirmed.',
  processing: 'Deposit received. The payout is on its way.',
  paid: 'Paid. The money has been sent to the account.',
  failed: `The payout failed. Any USDC you sent is due back to your connected wallet. ${REFUND_UNPROVEN}`,
  expired: `No deposit arrived in time, so this cash-out was cancelled. Any USDC you sent is due back to your connected wallet. ${REFUND_UNPROVEN}`,
  refunded:
    'The payout did not complete. Weave says your USDC was refunded to your connected wallet, so check that it arrived.',
}

export function statusText(status: CashoutStatus): string {
  return STATUS_TEXT[status]
}

export function shouldPoll(status: CashoutStatus): boolean {
  return status === 'waiting' || status === 'processing'
}

const MOBILE_PREFIX: Record<string, string> = {
  KES: '254712345678',
  UGX: '256712345678',
  TZS: '255712345678',
  NGN: '2348012345678',
}

export interface AccountHint {
  label: string
  placeholder: string
  inputMode: 'numeric' | 'tel'
}

/** A hint for the person typing. Whether the number is good is the server's answer. */
export function accountHint(type: InstitutionType | undefined, currency: string): AccountHint {
  if (type === 'mobile_money') {
    return {
      label: 'Phone number',
      placeholder: MOBILE_PREFIX[currency] ?? '',
      inputMode: 'tel',
    }
  }
  if (type === 'bank') {
    return {
      label: 'Account number',
      placeholder: '0123456789',
      inputMode: 'numeric',
    }
  }
  return {
    label: 'Account or phone number',
    placeholder: '',
    inputMode: 'numeric',
  }
}

export function cleanIdentifier(text: string): string {
  return text.replace(/[\s-]/g, '')
}

type SigningFamily = SigningPayload['family']

/**
 * These wallets broadcast for themselves, so an error back may follow a transfer that went out. A
 * typed EVM message is only signed, and goes nowhere until the server posts it.
 */
export function walletSends(family: SigningFamily): boolean {
  return family === 'near' || family === 'evm'
}

export type AfterWallet =
  | { next: 'submit'; signed: SignedPayload }
  | { next: 'review' }
  | { next: 'failed'; error: string }
  | { next: 'check' }

/**
 * On a wallet that sends for itself, neither a decline nor an error rules out a
 * transfer: an error after broadcast comes back with no hash, and a dropped
 * connection can read as a decline. Only signed-bytes wallets can return to review.
 */
export function afterWallet(outcome: SignedOutcome, family: SigningFamily): AfterWallet {
  if (outcome.ok) return { next: 'submit', signed: outcome.signed }
  if (walletSends(family)) return { next: 'check' }
  if (outcome.reason === 'rejected') return { next: 'review' }
  return { next: 'failed', error: outcome.detail ?? 'The wallet could not sign this.' }
}

export const CHECK_WALLET =
  "Your wallet didn't confirm this transfer, and it may still have gone out. Check your wallet's activity first, in case it was sent."

function shortAccount(account: string): string {
  return account.length > 12 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account
}

/**
 * The refusal for signing from a wallet other than the order's, or nothing. An EVM
 * payload names no account, so nothing later on would catch this. Hex addresses
 * differ only by checksum case; on other chains case is part of the address.
 */
export function accountMismatch(
  connected: string | undefined,
  account: string
): string | undefined {
  const same = (a: string, b: string): boolean =>
    a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b
  if (connected !== undefined && same(connected, account)) return undefined
  return `This order was made for the wallet ${shortAccount(account)}. Switch back to that wallet to sign it. Nothing was sent.`
}

export type AfterSubmit =
  | { next: 'tracking'; hash: string; explorerUrl: string }
  | { next: 'pending'; error: string }
  | { next: 'failed'; error: string }

/**
 * Only an explicit, clean refusal of something this app would have sent counts
 * as a failure. Every other answer leaves open that the money moved.
 */
export function afterSubmit(result: unknown, family: SigningFamily): AfterSubmit {
  const body = (typeof result === 'object' && result !== null ? result : {}) as {
    ok?: unknown
    hash?: unknown
    explorerUrl?: unknown
    error?: unknown
    pending?: unknown
  }
  if (body.ok === true && typeof body.hash === 'string') {
    return {
      next: 'tracking',
      hash: body.hash,
      explorerUrl: typeof body.explorerUrl === 'string' ? body.explorerUrl : '',
    }
  }
  if (body.ok === false && body.pending !== true && !walletSends(family)) {
    return {
      next: 'failed',
      error:
        typeof body.error === 'string' && body.error.includes(' ')
          ? body.error
          : 'The deposit did not go through.',
    }
  }
  return { next: 'pending', error: PENDING_MESSAGE }
}

export interface CashoutAttempt {
  fingerprint: string
  key: string
}

/** The same request keeps its key, so a retry can't become a second order. */
export function nextAttempt(
  current: CashoutAttempt | null,
  fingerprint: string,
  mint: () => string
): CashoutAttempt {
  return current !== null && current.fingerprint === fingerprint
    ? current
    : { fingerprint, key: mint() }
}

export function depositConfirmed(order: CashoutOrderView): boolean {
  return (order.depositHash !== undefined && order.depositHash !== '') || order.status !== 'waiting'
}

/** A retried request can return an order already under way: that one is followed, never paid again. */
export function orderPhase(order: CashoutOrderView): 'review' | 'tracking' {
  return depositConfirmed(order) ? 'tracking' : 'review'
}

export function canSign(phase: CashoutPhase, order: CashoutOrderView | undefined): boolean {
  return phase === 'review' && order !== undefined && !depositConfirmed(order)
}

/** True while money may be moving: nothing may close this card or start another. */
export function isLocked(phase: CashoutPhase, order: CashoutOrderView | undefined): boolean {
  if (phase === 'signing' || phase === 'submitting') return true
  if (phase === 'tracking' || phase === 'pending' || phase === 'check') {
    return order === undefined || shouldPoll(order.status)
  }
  return false
}

export const NO_CASHOUTS = "Cash-outs aren't available right now."

export const CURRENCY_QUESTION = 'Which currency do you want this paid out in?'

const NAIRA: CashoutCurrency = {
  code: 'NGN',
  name: 'Nigerian naira',
  symbol: '₦',
  country: 'Nigeria',
}

/**
 * What to offer when asking. Weave's list leaves naira out on Stellar, where it
 * stays on Linq, and a person there can still choose it.
 */
export function cashoutChoices(
  chain: string,
  weave: readonly CashoutCurrency[]
): CashoutCurrency[] {
  return chain === 'stellar' ? [NAIRA, ...weave.filter((c) => c.code !== 'NGN')] : [...weave]
}

/** On a chain closed to cash-outs, swapping first would not help, and neither would a token named. */
export function unsupportedTokenReply(token: string, chain: string): string {
  return (
    closedCashoutReply(chain) ??
    `Cash-outs take USDC, not ${token}. Swap your ${token} to USDC first, then cash out.`
  )
}

export function unsupportedCurrencyReply(
  currency: string,
  available: readonly CashoutCurrency[]
): string {
  if (available.length === 0) return NO_CASHOUTS
  const list = available.map((c) => `${c.name} (${c.code})`).join(', ')
  return `Cash-outs don't pay out in ${currency}. You can cash out to: ${list}.`
}

const EXPLORER_TX: Record<CashoutChain, string> = {
  stellar: 'https://stellar.expert/explorer/public/tx/',
  solana: 'https://solscan.io/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  sui: 'https://suiscan.xyz/mainnet/tx/',
  near: 'https://nearblocks.io/txns/',
}

export function depositExplorerUrl(chain: CashoutChain, hash: string): string {
  return `${EXPLORER_TX[chain]}${hash}`
}

const EXPLORER_NAME: Record<CashoutChain, string> = {
  stellar: 'Stellar Expert',
  solana: 'Solscan',
  avalanche: 'Snowtrace',
  sui: 'Suiscan',
  near: 'NearBlocks',
}

export function explorerName(chain: CashoutChain): string {
  return EXPLORER_NAME[chain]
}
