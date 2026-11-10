import {
  ChainActionRefused,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type NearTransaction,
  type PreparedAction,
  type SigningPayload,
  type SubmitInput,
  type SubmitResult,
  type VenuePosition,
  type VenueQuote,
  takesOnly,
} from '../types'
import { NEAR_ACCOUNT, NEAR_TX_HASH } from './account'
import { isRegistered, viewCall, waitForTransaction } from './rpc'
import {
  assertIntentsSaleSafe,
  assertIntentsWithdrawalSafe,
  assertOneClickSafe,
  DEPOSIT_ADDRESS,
  INTENTS_CALL_GAS,
  INTENTS_CONTRACT,
  STORAGE_DEPOSIT_YOCTO,
  STORAGE_GAS,
} from './safety'
import {
  assertNearAccount,
  assertNoDepositMemo,
  costNote,
  liveOneClick,
  ONECLICK_RISK_NOTE,
  prepareOneClickDeposit,
  previewOneClick,
  quoteOneClick,
  submitOneClick,
  type Destination,
  type QuoteOrigin,
} from './swap'
import { explorerUrl, formatUnits, nearTokens, USDC_NEAR, USDT_NEAR } from './tokens'

export const EARN_VENUE_ID = '1click-earn'
const VENUE_NAME = '1Click Earn'
/** Handed back at submit: a collection from the balance has no swap to follow. */
const CLAIM_STEP = 'claim'
const CONFIRM_WAIT_MS = 25_000
const BALANCE_RECHECK_MS = 2_000

/**
 * Gauntlet USDC Prime, a Morpho vault on Base. Listed in the Earn docs, with this
 * asset id and decimals confirmed against the live 1Click token list. Chosen over
 * Taler USDC, which quotes at smaller sizes but has no independent usage data.
 *
 * The share stays in the user's NEAR Intents balance, because a NEAR wallet has no
 * address on Base to deliver it to.
 */
const VAULT = {
  assetId: 'nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near',
  symbol: 'gtUSDCp',
  decimals: 18,
  recipientType: 'INTENTS',
} as const

const SHARE_ORIGIN: QuoteOrigin = { assetId: VAULT.assetId, decimals: VAULT.decimals }

/**
 * The way out lands in the NEAR Intents balance, not the wallet. 1Click won't quote a route that
 * pays out on NEAR itself as of 5 November 2026, and the collection needs no company anyway.
 */
const USDC_IN_BALANCE: Destination = {
  assetId: `nep141:${USDC_NEAR}`,
  symbol: 'USDC',
  decimals: 6,
  recipientType: 'INTENTS',
}

const EARN_NOTE =
  "Your stablecoin becomes a share in Gauntlet USDC Prime, a Morpho vault on Base, held in your NEAR Intents balance. That stacks bridge, NEAR Intents and vault risk, the principal isn't guaranteed, and 1Click publishes no rate to show here. Getting out takes two signatures: one sells the share for USDC through 1Click, and one brings that USDC to your wallet."

function stablecoinIn(request: ChainActionRequest): ChainToken {
  const tokenIn = tokenBySymbol(nearTokens, request.tokenIn)
  if (
    request.kind !== 'supply' ||
    tokenIn === undefined ||
    (tokenIn.id !== USDC_NEAR && tokenIn.id !== USDT_NEAR)
  ) {
    throw new ChainActionRefused(`${VENUE_NAME} here takes USDC or USDT.`)
  }
  return tokenIn
}

/** No apyPercent: 1Click publishes no rate for the vault, and a rate is never invented. */
async function quoteEarn(request: ChainActionRequest, account: string): Promise<VenueQuote> {
  return quoteOneClick(request.amount, stablecoinIn(request), VAULT, account)
}

async function prepareEarn(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  const tokenIn = stablecoinIn(request)
  return prepareOneClickDeposit(
    {
      venueId: EARN_VENUE_ID,
      venueName: VENUE_NAME,
      kind: 'supply',
      summary: (amount, token) =>
        `Put ${amount} ${token.symbol} into a vault on Base through NEAR Intents. Vault shares are small units, so the share count looks large.`,
      extraNotes: [EARN_NOTE],
    },
    request.amount,
    tokenIn,
    VAULT,
    account
  )
}

/** What this account holds of a token in its NEAR Intents balance. Throws when it can't read. */
async function intentsBalance(account: string, assetId: string): Promise<bigint> {
  return BigInt(
    await viewCall<string>(INTENTS_CONTRACT, 'mt_balance_of', {
      account_id: account,
      token_id: assetId,
    })
  )
}

function sharesText(shares: bigint): string {
  return formatUnits(shares.toString(), VAULT.decimals, VAULT.decimals)
}

function cannotRead(): ChainActionRefused {
  return new ChainActionRefused(
    `${VENUE_NAME} could not be read from NEAR just now, so nothing was built. Try again in a minute.`
  )
}

function oneYoctoCall(
  methodName: string,
  args: Record<string, unknown>
): NearTransaction['actions'][number] {
  return {
    type: 'FunctionCall',
    params: { methodName, args, gas: INTENTS_CALL_GAS.toString(), deposit: '1' },
  }
}

/**
 * The share in USDC is whatever a solver will pay now, so the figure comes from a dry 1Click quote.
 * When 1Click can't price it this throws, because only the share count would be known.
 */
async function earnPositions(account: string): Promise<VenuePosition[]> {
  if (!NEAR_ACCOUNT.test(account)) throw new Error('not a NEAR account')
  const [shares, waiting] = await Promise.all([
    intentsBalance(account, VAULT.assetId),
    intentsBalance(account, USDC_IN_BALANCE.assetId),
  ])
  const positions: VenuePosition[] = []
  if (shares > BigInt(0)) {
    const { preview } = await previewOneClick(
      sharesText(shares),
      SHARE_ORIGIN,
      USDC_IN_BALANCE,
      account,
      true
    )
    positions.push({
      slot: 'supplied',
      symbol: 'USDC',
      amount: formatUnits(preview.quote.amountOut, USDC_IN_BALANCE.decimals),
    })
  }
  if (waiting > BigInt(0)) {
    positions.push({
      slot: 'claimable',
      symbol: 'USDC',
      amount: formatUnits(waiting.toString(), USDC_IN_BALANCE.decimals),
    })
  }
  return positions
}

/** How many shares to sell. All of them for the whole position, so no share is left behind. */
async function sharesToSell(
  request: ChainActionRequest,
  held: bigint,
  account: string
): Promise<bigint> {
  if (request.wholePosition === true) return held
  const asked = BigInt(toBaseUnits(request.amount, USDC_IN_BALANCE.decimals))
  const { preview } = await previewOneClick(
    sharesText(held),
    SHARE_ORIGIN,
    USDC_IN_BALANCE,
    account,
    true
  )
  const worth = BigInt(preview.quote.amountOut)
  if (asked > worth) {
    throw new ChainActionRefused(
      `Your ${VENUE_NAME} position is worth about ${formatUnits(worth.toString(), USDC_IN_BALANCE.decimals)} USDC, which is less than ${request.amount}. Nothing was signed or sent.`
    )
  }
  const rounded = (held * asked + worth - BigInt(1)) / worth
  return rounded > held ? held : rounded
}

async function prepareWithdraw(
  request: ChainActionRequest,
  account: string
): Promise<PreparedAction> {
  assertNearAccount(account)
  if (tokenBySymbol(nearTokens, request.tokenIn)?.id !== USDC_NEAR) {
    throw new ChainActionRefused(
      `${VENUE_NAME} pays out in USDC, so say it in USDC. Nothing was signed or sent.`
    )
  }
  let held: bigint
  try {
    held = await intentsBalance(account, VAULT.assetId)
  } catch {
    throw cannotRead()
  }
  if (held === BigInt(0)) {
    throw new ChainActionRefused(`You have nothing in ${VENUE_NAME}. Nothing was signed or sent.`)
  }

  const shares = await sharesToSell(request, held, account)
  const { shared } = await previewOneClick(
    sharesText(shares),
    SHARE_ORIGIN,
    USDC_IN_BALANCE,
    account,
    true
  )
  const { live, loss, deadline } = await liveOneClick(shared, SHARE_ORIGIN, USDC_IN_BALANCE)

  const { depositAddress } = live.quote
  if (depositAddress === undefined || !DEPOSIT_ADDRESS.test(depositAddress)) {
    throw new ChainActionRefused(
      "NEAR Intents' deposit address didn't look right, so it was not used. Nothing was signed or sent."
    )
  }
  assertNoDepositMemo(live)

  const out = formatUnits(live.quote.amountOut, USDC_IN_BALANCE.decimals)
  return {
    venueId: EARN_VENUE_ID,
    venueName: VENUE_NAME,
    kind: 'withdraw',
    summary: `Sell your vault share for about ${out} USDC, which lands in your NEAR Intents balance. A second signature brings it to your wallet.`,
    pay: { amount: out, symbol: 'USDC' },
    receive: { amount: out, symbol: 'USDC', approximate: true },
    notes: [
      costNote(live, loss, USDC_IN_BALANCE.symbol, USDC_IN_BALANCE.decimals),
      'This is the first of two steps. Once the USDC reaches your NEAR Intents balance, say "claim my USDC" to bring it to your wallet, which calls the contract directly and needs no company.',
      `This step needs 1Click's quote and a solver to take the share, so it can't run while 1Click is down. The share goes to a one-time deposit address from 1Click, which this app can't check on-chain. Sign within 5 minutes. If the sale can't finish, the share returns to your NEAR Intents balance at ${account}.`,
      ONECLICK_RISK_NOTE,
    ],
    signing: {
      family: 'near',
      transactions: [
        {
          receiverId: INTENTS_CONTRACT,
          actions: [
            oneYoctoCall('mt_transfer', {
              receiver_id: depositAddress,
              token_id: VAULT.assetId,
              amount: shares.toString(),
            }),
          ],
        },
      ],
    },
    context: { depositAddress, deadline },
  }
}

async function prepareClaim(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  assertNearAccount(account)
  if (tokenBySymbol(nearTokens, request.tokenIn)?.id !== USDC_NEAR) {
    throw new ChainActionRefused(
      `${VENUE_NAME} pays out in USDC, so say it in USDC. Nothing was signed or sent.`
    )
  }
  let waiting: bigint
  let registered: boolean
  try {
    ;[waiting, registered] = await Promise.all([
      intentsBalance(account, USDC_IN_BALANCE.assetId),
      isRegistered(USDC_NEAR, account),
    ])
  } catch {
    throw cannotRead()
  }
  if (waiting === BigInt(0)) {
    throw new ChainActionRefused(
      `There is no USDC waiting in your NEAR Intents balance. If you have just sold your vault share, the sale can take a few minutes. Nothing was signed or sent.`
    )
  }

  const amount = formatUnits(waiting.toString(), USDC_IN_BALANCE.decimals)
  const withdrawal: NearTransaction = {
    receiverId: INTENTS_CONTRACT,
    actions: [
      oneYoctoCall('ft_withdraw', {
        token: USDC_NEAR,
        receiver_id: account,
        amount: waiting.toString(),
      }),
    ],
  }
  const registration: NearTransaction = {
    receiverId: USDC_NEAR,
    actions: [
      {
        type: 'FunctionCall',
        params: {
          methodName: 'storage_deposit',
          args: { account_id: account, registration_only: true },
          gas: STORAGE_GAS.toString(),
          deposit: STORAGE_DEPOSIT_YOCTO,
        },
      },
    ],
  }
  return {
    venueId: EARN_VENUE_ID,
    venueName: VENUE_NAME,
    kind: 'claim',
    summary: `Bring ${amount} USDC from your NEAR Intents balance into your wallet.`,
    pay: { amount, symbol: 'USDC' },
    receive: { amount, symbol: 'USDC', approximate: false },
    notes: [
      'This calls the NEAR Intents contract directly and needs no company. It collects all the USDC in that balance. If the transfer fails, the USDC stays in your balance there.',
      ...(registered
        ? []
        : [
            'This also pays 0.00125 NEAR to register you on USDC, as a separate transaction first.',
          ]),
    ],
    signing: {
      family: 'near',
      transactions: registered ? [withdrawal] : [registration, withdrawal],
    },
    context: { step: CLAIM_STEP },
  }
}

/** The swap check, without the wrap path: this venue only ever spends stablecoins. */
function assertEarnSafe(payload: SigningPayload, account: string): void {
  if (payload.family === 'near' && Array.isArray(payload.transactions)) {
    const last = payload.transactions[payload.transactions.length - 1]
    if (last?.receiverId === INTENTS_CONTRACT) {
      const first = last.actions?.[0]
      if (first?.type === 'FunctionCall' && first.params?.methodName === 'mt_transfer') {
        assertIntentsSaleSafe(payload, account, VAULT.assetId)
      } else {
        assertIntentsWithdrawalSafe(payload, account, USDC_NEAR)
      }
      return
    }
  }
  assertOneClickSafe(payload, account)
  if (payload.family !== 'near') return
  const receiver = payload.transactions[0]?.receiverId
  if (receiver !== USDC_NEAR && receiver !== USDT_NEAR) {
    throw new ChainActionRefused(
      `This transaction was stopped before signing because ${VENUE_NAME} only spends USDC or USDT. Nothing was signed or sent.`
    )
  }
}

/**
 * A transaction can succeed with the transfer inside it refused, in which case the contract puts
 * the USDC back in the balance. So the balance is read again rather than taking success for it.
 */
async function confirmClaim(input: SubmitInput): Promise<SubmitResult> {
  const { account, signed } = input
  if (signed.family !== 'near') return { ok: false, error: 'That is not a NEAR transaction.' }
  const hash = signed.hashes[signed.hashes.length - 1]
  if (hash === undefined || signed.hashes.some((h) => !NEAR_TX_HASH.test(h))) {
    return {
      ok: false,
      pending: true,
      error: 'The wallet did not return a transaction hash to follow.',
    }
  }
  const giveUpAt = Date.now() + CONFIRM_WAIT_MS
  for (const each of signed.hashes) {
    const outcome = await waitForTransaction(each, account, Math.max(giveUpAt - Date.now(), 1))
    if (outcome.state === 'unknown') {
      return {
        ok: false,
        pending: true,
        error: `Your transaction was sent (${each}) but hasn't been confirmed yet. Don't send it again. Check ${explorerUrl(each)} in a minute.`,
      }
    }
    if (outcome.state === 'failed') {
      return {
        ok: false,
        error: `That failed on NEAR (${each}), so your USDC is still in your NEAR Intents balance, apart from the gas. You can try again.`,
      }
    }
    const isLast = each === hash
    const withdrawal = outcome.calls.find((c) => c.method === 'ft_withdraw')
    const matches = isLast
      ? outcome.receiver === INTENTS_CONTRACT &&
        withdrawal?.args['receiver_id'] === account &&
        withdrawal.args['token'] === USDC_NEAR
      : outcome.receiver === USDC_NEAR
    if (outcome.signer !== account || !matches) {
      return {
        ok: false,
        pending: true,
        error: `Transaction ${each} is not this account's withdrawal from NEAR Intents. Check your wallet's activity.`,
      }
    }
    if (isLast && !(await balanceDropped(account, withdrawal?.args['amount'], giveUpAt))) {
      return {
        ok: false,
        pending: true,
        error: `NEAR finished transaction ${each}, but the USDC still shows in your NEAR Intents balance, so the transfer may have been refused. Check your wallet. If the USDC is still in that balance in a few minutes, claim it again.`,
      }
    }
  }
  return { ok: true, hash, explorerUrl: explorerUrl(hash) }
}

/** Reads settle a few blocks behind the transaction, so a figure that hasn't moved is read again. */
async function balanceDropped(
  account: string,
  amount: unknown,
  giveUpAt: number
): Promise<boolean> {
  const moved = BigInt(String(amount ?? '0'))
  for (;;) {
    const left = await intentsBalance(account, USDC_IN_BALANCE.assetId).catch(() => undefined)
    if (left !== undefined && left < moved) return true
    if (Date.now() >= giveUpAt) return false
    await new Promise((resolve) => setTimeout(resolve, BALANCE_RECHECK_MS))
  }
}

export const earnVenue: ChainVenue = {
  id: EARN_VENUE_ID,
  name: VENUE_NAME,
  kinds: ['supply', 'withdraw', 'claim'],
  assertCanFollow: takesOnly(VENUE_NAME, ['USDC', 'USDT']),
  quote: quoteEarn,
  prepare: (request, account) => {
    if (request.kind === 'withdraw') return prepareWithdraw(request, account)
    if (request.kind === 'claim') return prepareClaim(request, account)
    return prepareEarn(request, account)
  },
  positions: earnPositions,
  assertSafe: assertEarnSafe,
  submit: (input) =>
    input.context?.['step'] === CLAIM_STEP ? confirmClaim(input) : submitOneClick(input),
}
