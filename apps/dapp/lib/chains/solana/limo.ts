import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getU32Encoder,
  getU64Encoder,
  isAddress,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from '@solana/kit'
import { z } from 'zod'

import { limitOutput, limitPair, type LimitBook, type RestingOrder } from '../limit'
import {
  ChainActionRefused,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
} from '../types'
import { TOKEN_PROGRAM } from './assert-safe'
import { rpc } from './balances'
import {
  closeInstructions,
  createInstructions,
  decodeGlobalConfig,
  decodeOrder,
  inputVault,
  limoAssertSafe,
  limoPair,
  limoToken,
  ORDER_DISCRIMINATOR_BASE58,
  type LimoOrder,
} from './limo-rules'
import { LIMO_GLOBAL_CONFIG, LIMO_ORDER_BYTES, LIMO_PROGRAM } from './programs'
import { fromBaseUnits } from './tokens'

const VENUE_ID = 'kamino-limit'
const VENUE_NAME = 'Kamino Limit Orders'
const SOL_DECIMALS = 9
const READ_TIMEOUT_MS = 15_000
const MAX_U64 = BigInt('18446744073709551615')
/**
 * `create_order` takes this from the maker inside the program, where the signed bytes can't show it,
 * so the live config is read and held to this. The fee is 0.003 SOL today.
 */
const MAX_ORDER_COST_LAMPORTS = BigInt(10_000_000)

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111' as Address
/**
 * Simulated at 38,524 units for SOL to USDC on 5 November 2026, with both token accounts already
 * there. Creating them adds about 30,000 each.
 */
const COMPUTE_UNIT_LIMIT = 200_000
/**
 * About 0.00002 SOL at the limit above. A wallet can't add a priority fee of its own to an order,
 * because that would break the order key's signature.
 */
const COMPUTE_UNIT_PRICE = BigInt(100_000)

export interface Lifetime {
  blockhash: string
  lastValidBlockHeight: number
}

function refused(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

function compile(account: string, instructions: readonly Instruction[], lifetime: Lifetime) {
  return pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(account as Address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: lifetime.blockhash as Blockhash,
          lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
        },
        m
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          {
            programAddress: COMPUTE_BUDGET_PROGRAM,
            data: Uint8Array.from([2, ...getU32Encoder().encode(COMPUTE_UNIT_LIMIT)]),
          },
          {
            programAddress: COMPUTE_BUDGET_PROGRAM,
            data: Uint8Array.from([3, ...getU64Encoder().encode(COMPUTE_UNIT_PRICE)]),
          },
          ...instructions,
        ],
        m
      ),
    (m) => compileTransaction(m)
  )
}

function baseUnits(amount: string, token: ChainToken): bigint {
  try {
    return BigInt(toBaseUnits(amount, token.decimals))
  } catch (e) {
    if (e instanceof ChainActionRefused) refused(e.message)
    throw e
  }
}

export interface BuildCreateInput {
  account: string
  tokenIn: string
  tokenOut: string
  amount: string
  limitPrice: string
  lifetime: Lifetime
}

export interface BuiltCreate {
  /** Base64, with the order key's signature in place and the wallet's slot empty. */
  transaction: string
  order: string
  /** What `limoAssertSafe` compares a create with. */
  context: { inputMint: string; outputMint: string; inputAmount: string; outputAmount: string }
}

function orderAmounts(tokenIn: string, tokenOut: string, amount: string, limitPrice: string) {
  const { input, output, selling } = limoPair(tokenIn, tokenOut)
  const inputAmount = baseUnits(amount, input)
  const outputAmount = limitOutput(amount, limitPrice, selling, input.decimals, output.decimals)
  if (inputAmount > MAX_U64 || outputAmount > MAX_U64 || outputAmount === BigInt(0)) {
    refused('That amount and price are outside what an order can hold.')
  }
  return { input, output, inputAmount, outputAmount }
}

/**
 * The order's account needs a key to be created, and nothing else ever uses it. So one is made here,
 * can't be exported, signs this one message, and is gone when this returns. The wallet's signature is
 * added to the same bytes: the order key's stays valid, as the wallet signs the same message.
 */
export async function buildCreate(input: BuildCreateInput): Promise<BuiltCreate> {
  const { account, tokenIn, tokenOut, amount, limitPrice, lifetime } = input
  const amounts = orderAmounts(tokenIn, tokenOut, amount, limitPrice)
  const keyPair = await generateKeyPair()
  const order = await getAddressFromPublicKey(keyPair.publicKey)
  const inputMint = amounts.input.id
  const outputMint = amounts.output.id
  const instructions = createInstructions({
    account,
    order,
    inputMint,
    outputMint,
    inputAmount: amounts.inputAmount,
    outputAmount: amounts.outputAmount,
  })
  const signed = await partiallySignTransaction([keyPair], compile(account, instructions, lifetime))
  return {
    transaction: getBase64EncodedWireTransaction(signed),
    order,
    context: {
      inputMint,
      outputMint,
      inputAmount: amounts.inputAmount.toString(),
      outputAmount: amounts.outputAmount.toString(),
    },
  }
}

const Account = z.object({
  data: z.tuple([z.string(), z.string()]),
  owner: z.string(),
  lamports: z.number(),
})

const Accounts = z.object({ value: z.array(Account.nullable()) })
const OneAccount = z.object({ value: Account.nullable() })
const Blockhashed = z.object({
  value: z.object({ blockhash: z.string(), lastValidBlockHeight: z.number() }),
})
const Listed = z.array(z.object({ pubkey: z.string(), account: Account }))

const bytesOf = (account: z.infer<typeof Account>): Uint8Array =>
  Uint8Array.from(Buffer.from(account.data[0], 'base64'))

/** A read needed before anything can be built. Failing means building nothing, said in words. */
async function mustRead(method: string, params: unknown[], what: string): Promise<unknown> {
  try {
    return await rpc(method, params, AbortSignal.timeout(READ_TIMEOUT_MS))
  } catch {
    return refused(`I couldn’t read ${what} just now, so try again in a moment.`)
  }
}

async function readLifetime(): Promise<Lifetime> {
  const reply = Blockhashed.safeParse(
    await mustRead('getLatestBlockhash', [{ commitment: 'confirmed' }], 'the Solana network')
  )
  if (!reply.success) refused('I couldn’t read the Solana network just now.')
  return reply.data.value
}

/**
 * Holds the live config to what the signed bytes can't show, and refuses a mint with no vault: making
 * one is rent the person would never get back, for a vault everybody else then shares. Returns the
 * lamports `create_order` will take.
 */
async function checkedCost(inputMint: string, symbol: string): Promise<bigint> {
  const reply = Accounts.safeParse(
    await mustRead(
      'getMultipleAccounts',
      [
        [LIMO_GLOBAL_CONFIG, inputVault(inputMint)],
        { encoding: 'base64', commitment: 'confirmed' },
      ],
      'Kamino’s settings'
    )
  )
  const [configAccount, vault] = reply.success ? reply.data.value : []
  const config =
    configAccount !== null && configAccount !== undefined && configAccount.owner === LIMO_PROGRAM
      ? decodeGlobalConfig(bytesOf(configAccount))
      : undefined
  if (config === undefined) refused('I couldn’t read Kamino’s settings just now.')
  if (config.newOrdersBlocked || config.emergencyMode) {
    refused('Kamino is not taking new orders right now.')
  }
  if (config.cost > MAX_ORDER_COST_LAMPORTS) {
    refused(
      `Kamino now charges about ${fromBaseUnits(config.cost.toString(), SOL_DECIMALS)} SOL to place an order, above the ${fromBaseUnits(MAX_ORDER_COST_LAMPORTS.toString(), SOL_DECIMALS)} SOL I accept.`
    )
  }
  if (vault === null || vault === undefined || vault.owner !== TOKEN_PROGRAM) {
    refused(`Kamino has no vault for ${symbol} yet, so I can’t place this.`)
  }
  return config.cost
}

async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  if (!isAddress(account)) refused('That is not a Solana wallet address.')
  if (request.kind !== 'limit')
    refused(`${VENUE_NAME} only rests orders. It can’t ${request.kind}.`)
  const { tokenIn, amount } = request
  const tokenOut = request.tokenOut ?? ''
  const limitPrice = request.limitPrice ?? ''
  const { input, output, base, quote } = limoPair(tokenIn, tokenOut)
  const { outputAmount } = orderAmounts(tokenIn, tokenOut, amount, limitPrice)

  const cost = await checkedCost(input.id, input.symbol)
  const built = await buildCreate({
    account,
    tokenIn,
    tokenOut,
    amount,
    limitPrice,
    lifetime: await readLifetime(),
  })

  const received = fromBaseUnits(outputAmount.toString(), output.decimals)
  return {
    venueId: VENUE_ID,
    venueName: VENUE_NAME,
    kind: 'limit',
    summary: `Offer ${amount} ${input.symbol} on Kamino for at least ${received} ${output.symbol}, at ${limitPrice} ${quote} per ${base}.`,
    pay: { amount, symbol: input.symbol },
    receive: { amount: received, symbol: output.symbol, approximate: false },
    notes: [
      'This stays open until it fills or you cancel it. There is no expiry.',
      `Costs about ${fromBaseUnits(cost.toString(), SOL_DECIMALS)} SOL, probably not refunded, and locks 0.00384 SOL until you close the order.`,
      'Only Pyth Express Relay searchers fill it. It may never fill, and small orders are less likely to.',
      'Kamino can upgrade this program, so your escrowed amount carries that risk.',
    ],
    signing: { family: 'solana', transaction: built.transaction },
    context: built.context,
  }
}

export function createKaminoLimitVenue(): ChainVenue {
  return {
    id: VENUE_ID,
    name: VENUE_NAME,
    kinds: ['limit'],
    prepare,
    assertSafe: limoAssertSafe,
    limitCost: { amount: '0.00684', symbol: 'SOL' },
  }
}

function solBack(lamports: number, order: LimoOrder): string {
  return fromBaseUnits((BigInt(lamports) + order.tip).toString(), SOL_DECIMALS)
}

/** The stablecoin per token, the way up a person named it, or nothing for a pair of two stablecoins. */
function priceOf(order: LimoOrder, input: ChainToken, output: ChainToken): string | undefined {
  const pair = limitPair(input.symbol, output.symbol)
  if (pair === undefined) return undefined
  const given = Number(fromBaseUnits(order.initialInput.toString(), input.decimals))
  const got = Number(fromBaseUnits(order.expectedOutput.toString(), output.decimals))
  const price = pair.selling ? got / given : given / got
  return String(Number(price.toPrecision(6)))
}

function restingOrder(
  address: string,
  lamports: number,
  order: LimoOrder
): RestingOrder | undefined {
  const input = limoToken(order.inputMint)
  const output = limoToken(order.outputMint)
  if (input === undefined || output === undefined) return undefined
  const limitPrice = priceOf(order, input, output)
  const fields: RestingOrder = {
    id: address,
    venueId: VENUE_ID,
    tokenIn: input.symbol,
    tokenOut: output.symbol,
    amountIn: fromBaseUnits(order.initialInput.toString(), input.decimals),
    remainingIn: fromBaseUnits(order.remainingInput.toString(), input.decimals),
    receivedOut: fromBaseUnits(order.filledOutput.toString(), output.decimals),
    status: 'done',
    ...(limitPrice !== undefined ? { limitPrice } : {}),
  }
  if (order.status === 0) {
    return { ...fields, status: order.remainingInput < order.initialInput ? 'partly' : 'open' }
  }
  if (order.status !== 1) return fields
  const back = solBack(lamports, order)
  return {
    ...fields,
    status: 'filled',
    collectable: [{ amount: back, symbol: 'SOL' }],
    note: `It filled, and your ${output.symbol} was paid then. Closing it brings back about ${back} SOL of rent and tips.`,
  }
}

async function openOrders(account: string, signal?: AbortSignal): Promise<RestingOrder[]> {
  if (!isAddress(account)) refused('That is not a Solana wallet address.')
  const listed = Listed.parse(
    await rpc(
      'getProgramAccounts',
      [
        LIMO_PROGRAM,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          filters: [
            { dataSize: LIMO_ORDER_BYTES },
            { memcmp: { offset: 0, bytes: ORDER_DISCRIMINATOR_BASE58, encoding: 'base58' } },
            { memcmp: { offset: 8, bytes: LIMO_GLOBAL_CONFIG, encoding: 'base58' } },
            { memcmp: { offset: 40, bytes: account, encoding: 'base58' } },
          ],
        },
      ],
      signal ?? AbortSignal.timeout(READ_TIMEOUT_MS)
    )
  )
  return listed.flatMap(({ pubkey, account: held }) => {
    const order = decodeOrder(bytesOf(held))
    const resting = order === undefined ? undefined : restingOrder(pubkey, held.lamports, order)
    return resting === undefined ? [] : [resting]
  })
}

async function prepareExit(
  account: string,
  orderId: string,
  action: 'cancel' | 'collect'
): Promise<PreparedAction> {
  if (!isAddress(account)) refused('That is not a Solana wallet address.')
  if (!isAddress(orderId)) refused('That is not a Kamino order.')
  const reply = OneAccount.safeParse(
    await mustRead(
      'getAccountInfo',
      [orderId, { encoding: 'base64', commitment: 'confirmed' }],
      'that order'
    )
  )
  if (!reply.success) refused('I couldn’t read that order just now.')
  const held = reply.data.value
  if (held === null) refused('That order is not there any more, so it may already be closed.')
  const order = held.owner === LIMO_PROGRAM ? decodeOrder(bytesOf(held)) : undefined
  if (order === undefined || order.globalConfig !== LIMO_GLOBAL_CONFIG) {
    refused('That is not a Kamino order I can change.')
  }
  if (order.maker !== account) refused('That order belongs to another wallet.')
  const input = limoToken(order.inputMint)
  const output = limoToken(order.outputMint)
  if (input === undefined || output === undefined) {
    refused('That order is on a token this app doesn’t trade, so close it on Kamino.')
  }

  if (order.status > 1) refused('That order has already been cancelled.')
  if (action === 'collect' && order.status === 0) {
    refused('That order is still open, and closing it would cancel it. Cancel it if you meant to.')
  }
  if (action === 'cancel' && order.status === 1) {
    refused('That order has already filled, so there is nothing to cancel. Collect it instead.')
  }

  const transaction = getBase64EncodedWireTransaction(
    compile(
      account,
      closeInstructions({
        account,
        order: orderId,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
      }),
      await readLifetime()
    )
  )

  const back = solBack(held.lamports, order)
  const signing = { family: 'solana' as const, transaction }
  if (action === 'collect') {
    return {
      venueId: VENUE_ID,
      venueName: VENUE_NAME,
      kind: 'limit',
      summary: `Close your filled Kamino order and get about ${back} SOL back, its rent and tips.`,
      pay: { amount: '0', symbol: 'SOL' },
      receive: { amount: back, symbol: 'SOL', approximate: false },
      notes: [`Your ${output.symbol} was paid when it filled, so this doesn’t change that.`],
      signing,
    }
  }
  const remaining = fromBaseUnits(order.remainingInput.toString(), input.decimals)
  return {
    venueId: VENUE_ID,
    venueName: VENUE_NAME,
    kind: 'limit',
    summary: `Cancel your Kamino order and get back ${remaining} ${input.symbol}, plus about ${back} SOL of rent and tips.`,
    pay: { amount: '0', symbol: input.symbol },
    receive: { amount: remaining, symbol: input.symbol, approximate: false },
    notes: ['A searcher could still fill it before this lands. Whatever filled stays yours.'],
    signing,
  }
}

export function limoBook(): LimitBook {
  return { openOrders, prepareExit }
}
