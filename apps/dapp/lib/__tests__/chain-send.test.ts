import { createHmac } from 'node:crypto'

import { Inputs, Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getU64Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from '@solana/kit'
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  zeroAddress,
  type Hex,
} from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as FOLLOW_ON } from '../../app/api/chain/[chain]/follow-on/route'
import { POST as PREPARE } from '../../app/api/chain/[chain]/prepare/route'
import { quoteChainRoutes } from '../agents/chain-routes'
import { buildEvmVenues, avalancheModule, monadModule } from '../chains/evm/module'
import { AVALANCHE_TOKENS, EVM_NATIVE_ID, MONAD_TOKENS } from '../chains/evm/tokens'
import { buildNearVenues, nearModule } from '../chains/near/module'
import { accountBalance, isRegistered, NearRpcError, waitForTransaction } from '../chains/near/rpc'
import { assertOneClickSafe, TRANSFER_GAS } from '../chains/near/safety'
import { USDC_NEAR, USDT_NEAR, WRAP_NEAR, nearTokens } from '../chains/near/tokens'
import { parseChainAction, racesFirst } from '../chains/parse-action'
import { assertFollowOnCanRun, prepareChainAction } from '../chains/prepare'
import { isValidRecipient, sendRefusal } from '../chains/recipient'
import { chainModule } from '../chains/registry'
import { solanaDeposit } from '../weave/deposit/solana'
import { SEND_NOTE, SEND_VENUE_ID, createSendVenue } from '../chains/send'
import { followOnRefusal } from '../chains/sequence'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAccount,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from '../chains/solana/assert-safe'
import { buildSolanaVenues, solanaModule } from '../chains/solana/module'
import { SOLANA_TOKENS } from '../chains/solana/tokens'
import { buildSuiVenues, suiModule } from '../chains/sui/module'
import { SUI_TOKENS } from '../chains/sui/tokens'
import { afterSubmitting } from '../chains/signing-flow'
import {
  ChainActionRefused,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainModule,
  type ChainToken,
  type ChainWithActions,
  type PreparedAction,
  type SigningPayload,
  type SubmitResult,
} from '../chains/types'
import { venues } from '../venues'
import type { NearFunctionCall } from '../chains/types'

vi.hoisted(() => {
  process.env['AUTH_SECRET'] = 'x'.repeat(48)
})

vi.mock('../chains/solana/submit', async (original) => {
  const actual = await original<typeof import('../chains/solana/submit')>()
  return {
    ...actual,
    createSolanaSubmit: () => actual.createSolanaSubmit({ pollMs: 0, maxPolls: 1, env: {} }),
  }
})

const core = vi.hoisted(() => ({
  listCoins: vi.fn(),
  getBalance: vi.fn(),
  getObjects: vi.fn(),
  executeTransaction: vi.fn(),
  resolveTransactionPlugin: vi.fn(),
}))

vi.mock('../chains/sui/client', async (original) => ({
  ...(await original<typeof import('../chains/sui/client')>()),
  suiClient: () => ({ core }),
}))

const rpc = vi.hoisted(() => ({
  tokenBalance: (async () => BigInt(0)) as (token: string, account: string) => Promise<bigint>,
  nativeBalance: (async () => BigInt(0)) as (account: string) => Promise<bigint>,
  waitForReceipt: (async () => {
    throw new Error('no receipt')
  }) as (hash: string) => Promise<unknown>,
  transaction: (async () => ({ value: BigInt(0), input: '0x' })) as (
    hash: string
  ) => Promise<{ value: bigint; input: string }>,
}))

vi.mock('../chains/evm/client', async (original) => ({
  ...(await original<typeof import('../chains/evm/client')>()),
  evmClient: () => ({
    tokenBalance: (token: string, account: string) => rpc.tokenBalance(token, account),
    nativeBalance: (account: string) => rpc.nativeBalance(account),
    waitForReceipt: (hash: string) => rpc.waitForReceipt(hash),
    transaction: (hash: string) => rpc.transaction(hash),
  }),
}))

vi.mock('../chains/near/rpc', async (original) => ({
  ...(await original<typeof import('../chains/near/rpc')>()),
  accountBalance: vi.fn(),
  isRegistered: vi.fn(),
  waitForTransaction: vi.fn(),
}))

vi.mock('../chains/registry', () => ({ chainModule: vi.fn() }))
vi.mock('../server/analytics', () => ({ logExecution: async () => undefined }))
vi.mock('../server/rate-limit', () => ({ enforceRateLimit: async () => undefined }))
vi.mock('../server/report', () => ({ reportError: () => undefined }))

const SOL_ME = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const SOL_TO = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const SOL_THIEF = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'

const SUI_ME = normalizeSuiAddress('0xa1')
const SUI_TO = normalizeSuiAddress('0xb1')
const SUI_THIEF = normalizeSuiAddress('0xdead')
const COIN_A = normalizeSuiAddress('0xc1')
const GAS_COIN = normalizeSuiAddress('0xf1')
const DIGEST = 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn'

const EVM_ME = getAddress(`0x${'a1'.repeat(20)}`)
const EVM_TO = getAddress(`0x${'b2'.repeat(20)}`)
const EVM_THIEF = getAddress(`0x${'c3'.repeat(20)}`)
const EVM_HASH = `0x${'4'.repeat(64)}`

const NEAR_ME = 'alice.near'
const NEAR_TO = 'bob.near'
const NEAR_THIEF = 'mallory.near'
const NEAR_HASH = '4'.repeat(44)

const WORDS_FOR_A_DEPOSIT = /\border\b|\bswap\b|\bdeposit\b|NEAR Intents|1Click/i

const SOL_USDC = tokenBySymbol(SOLANA_TOKENS, 'USDC') as ChainToken
const SUI_USDC = tokenBySymbol(SUI_TOKENS, 'USDC') as ChainToken
const AVAX_USDC = tokenBySymbol(AVALANCHE_TOKENS, 'USDC') as ChainToken

function request(over: Partial<ChainActionRequest>): ChainActionRequest {
  return { kind: 'send', amount: '5', tokenIn: 'USDC', ...over }
}

const TOKEN_TABLES: Record<ChainWithActions, readonly ChainToken[]> = {
  solana: SOLANA_TOKENS,
  sui: SUI_TOKENS,
  near: nearTokens,
  avalanche: AVALANCHE_TOKENS,
  monad: MONAD_TOKENS,
}

function moduleFor(chain: ChainWithActions, over: Partial<ChainModule> = {}): ChainModule {
  return {
    chain,
    tokens: TOKEN_TABLES[chain],
    venues: [createSendVenue(chain)],
    defaultVenue: { send: SEND_VENUE_ID },
    priceUsd: async () => 1,
    submit: async () => ({ ok: false, error: 'unused' }),
    balances: async () => ({ tokens: [], complete: false }),
    ...over,
  }
}

interface Sim {
  rpc: string[]
  accountOwner: string | undefined
  accountExecutable: boolean
  send: () => unknown
}

let sim: Sim

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const { method } = JSON.parse(init?.body as string) as { method: string }
      sim.rpc.push(method)
      const replies: Record<string, unknown> = {
        getAccountInfo: {
          result: {
            context: { slot: 1 },
            value:
              sim.accountOwner === undefined
                ? null
                : { owner: sim.accountOwner, executable: sim.accountExecutable },
          },
        },
        getLatestBlockhash: {
          result: {
            context: { slot: 1 },
            value: { blockhash: BLOCKHASH, lastValidBlockHeight: 9 },
          },
        },
        sendTransaction: method === 'sendTransaction' ? await sim.send() : undefined,
        getSignatureStatuses: {
          result: { value: [{ confirmationStatus: 'confirmed', err: null }] },
        },
        isBlockhashValid: { result: { value: true } },
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(replies[method] as object) }))
    })
  )
}

function coinObject(objectId: string, type = SUI_USDC.id, owner = SUI_ME) {
  return {
    objectId,
    version: '10',
    digest: DIGEST,
    owner: { $kind: 'AddressOwner', AddressOwner: owner },
    type: `0x2::coin::Coin<${type}>`,
  }
}

beforeEach(() => {
  sim = {
    rpc: [],
    accountOwner: undefined,
    accountExecutable: false,
    send: () => ({ result: 'sent' }),
  }
  installFetch()
  vi.stubEnv('AUTH_SECRET', 'x'.repeat(48))
  for (const mock of Object.values(core)) mock.mockReset()
  core.resolveTransactionPlugin.mockReturnValue(
    async (
      data: { gasData: { price: unknown; budget: unknown; payment: unknown } },
      _options: unknown,
      next: () => Promise<void>
    ) => {
      data.gasData.price = '1000'
      data.gasData.budget = '1000000'
      data.gasData.payment = [{ objectId: GAS_COIN, version: '10', digest: DIGEST }]
      await next()
    }
  )
  core.getObjects.mockImplementation(async ({ objectIds }: { objectIds: string[] }) => ({
    objects: objectIds.map((id) => coinObject(id)),
  }))
  core.listCoins.mockImplementation(async ({ coinType }: { coinType: string }) => ({
    objects: [{ ...coinObject(COIN_A, coinType), balance: '90000000' }],
    hasNextPage: false,
    cursor: null,
  }))
  core.executeTransaction.mockResolvedValue({
    Transaction: { digest: 'DIGESTx', effects: { status: { success: true } } },
  })
  rpc.tokenBalance = async () => BigInt(90_000_000)
  rpc.nativeBalance = async () => BigInt('90000000000000000000')
  rpc.waitForReceipt = async () => {
    throw new Error('no receipt')
  }
  rpc.transaction = async () => ({ value: BigInt(0), input: '0x' })
  vi.mocked(isRegistered).mockReset()
  vi.mocked(isRegistered).mockResolvedValue(true)
  vi.mocked(waitForTransaction).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function refusal(work: () => unknown): string {
  try {
    work()
  } catch (e) {
    expect(e).toBeInstanceOf(ChainActionRefused)
    return (e as Error).message
  }
  throw new Error('it was not refused')
}

async function refusalOf(work: Promise<unknown>): Promise<string> {
  const caught = await work.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(caught).toBeInstanceOf(ChainActionRefused)
  return (caught as Error).message
}

/** Bytes to a chosen recipient, carrying an extra transfer when asked, as a tampered browser's. */
function solanaBytes(fields: { to?: string; extra?: boolean } = {}): string {
  const mint = SOL_USDC.id
  const destination = associatedTokenAccount(fields.to ?? SOL_TO, mint)
  const transfer = (amount: bigint, target: string) => ({
    programAddress: TOKEN_PROGRAM as Address,
    accounts: [
      { address: associatedTokenAccount(SOL_ME, mint) as Address, role: AccountRole.WRITABLE },
      { address: mint as Address, role: AccountRole.READONLY },
      { address: target as Address, role: AccountRole.WRITABLE },
      { address: SOL_ME as Address, role: AccountRole.READONLY_SIGNER },
    ],
    data: Uint8Array.from([12, ...getU64Encoder().encode(amount), 6]),
  })
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(SOL_ME as Address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: BigInt(9) },
        m
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          {
            programAddress: ASSOCIATED_TOKEN_PROGRAM as Address,
            accounts: [
              { address: SOL_ME as Address, role: AccountRole.WRITABLE_SIGNER },
              { address: destination as Address, role: AccountRole.WRITABLE },
              { address: (fields.to ?? SOL_TO) as Address, role: AccountRole.READONLY },
              { address: mint as Address, role: AccountRole.READONLY },
              { address: SYSTEM_PROGRAM as Address, role: AccountRole.READONLY },
              { address: TOKEN_PROGRAM as Address, role: AccountRole.READONLY },
            ],
            data: Uint8Array.of(1),
          },
          transfer(BigInt(5_000_000), destination),
          ...(fields.extra === true
            ? [transfer(BigInt(1), associatedTokenAccount(SOL_THIEF, mint))]
            : []),
        ] as never,
        m
      )
  )
  return getBase64EncodedWireTransaction(compileTransaction(message as never))
}

function signedBytes(base64: string): string {
  const bytes = Buffer.from(base64, 'base64')
  bytes.fill(7, 1, 65)
  return bytes.toString('base64')
}

function suiBytes(fields: { to?: string; extra?: boolean } = {}): Promise<string> {
  const tx = new Transaction()
  tx.setSender(SUI_ME)
  tx.setGasOwner(SUI_ME)
  tx.setGasPrice(1000)
  tx.setGasBudget(1_000_000)
  tx.setGasPayment([{ objectId: GAS_COIN, version: '10', digest: DIGEST }])
  const coin = tx.object(Inputs.ObjectRef({ objectId: COIN_A, version: '10', digest: DIGEST }))
  const [split] = tx.splitCoins(coin, [BigInt(5_000_000)])
  tx.transferObjects([split as never], fields.to ?? SUI_TO)
  if (fields.extra === true) {
    const [more] = tx.splitCoins(coin, [BigInt(1)])
    tx.transferObjects([more as never], SUI_THIEF)
  }
  return tx.build().then(toBase64)
}

function transferLog(to: string, value: bigint, token = AVAX_USDC.id) {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: EVM_ME, to: to as Hex },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: BigInt(1),
    transactionHash: EVM_HASH,
    transactionIndex: 0,
    blockHash: `0x${'5'.repeat(64)}`,
    logIndex: 0,
    removed: false,
  }
}

describe('isValidRecipient', () => {
  it.each([
    ['solana', SOL_TO],
    ['sui', SUI_TO],
    ['avalanche', EVM_TO],
    ['monad', EVM_TO],
    ['near', 'bob.near'],
    ['near', 'a'.repeat(64)],
    ['near', 'sub.bob.near'],
  ] as const)('takes a real address on %s: %s', (chain, address) => {
    expect(isValidRecipient(chain, address)).toBe(true)
  })

  it.each([
    ['an EVM address on Solana', 'solana', EVM_TO],
    ['a Sui address on Solana', 'solana', SUI_TO],
    ['a name on Solana', 'solana', 'alice'],
    ['a Solana address on Sui', 'sui', SOL_TO],
    ['an EVM address on Sui', 'sui', EVM_TO],
    ['a Sui address without 0x', 'sui', SUI_TO.slice(2)],
    ['a short Sui address', 'sui', '0xa1'],
    ['a Solana address on Avalanche', 'avalanche', SOL_TO],
    ['a Sui address on Monad', 'monad', SUI_TO],
    ['an EVM address on NEAR', 'near', EVM_TO.toLowerCase()],
    ['a Solana address on NEAR', 'near', SOL_TO],
    ['a NEAR name with capitals', 'near', 'Bob.near'],
    ['a NEAR name with no dot', 'near', 'bob'],
  ] as const)('refuses %s', (_name, chain, address) => {
    expect(isValidRecipient(chain, address)).toBe(false)
  })

  it('takes an EVM address in all lower case, and refuses a wrong checksum', () => {
    const lower = EVM_TO.toLowerCase()
    expect(isValidRecipient('avalanche', lower)).toBe(true)
    expect(isValidRecipient('monad', lower)).toBe(true)
    const wrong = `0x${'B2'.repeat(19)}b2`
    expect(getAddress(wrong)).not.toBe(wrong)
    expect(isValidRecipient('avalanche', wrong)).toBe(false)
    expect(isValidRecipient('monad', wrong)).toBe(false)
  })

  it.each([
    ['solana', '11111111111111111111111111111111'],
    ['sui', `0x${'0'.repeat(64)}`],
    ['near', '0'.repeat(64)],
    ['avalanche', zeroAddress],
    ['monad', zeroAddress],
  ] as const)('refuses the zero address on %s', (chain, address) => {
    expect(isValidRecipient(chain, address)).toBe(false)
  })

  it('refuses every token contract in each chain’s table', () => {
    for (const token of SOLANA_TOKENS) expect(isValidRecipient('solana', token.id)).toBe(false)
    for (const token of nearTokens) {
      if (token.id.includes('.') || token.id.length === 64) {
        expect(isValidRecipient('near', token.id)).toBe(false)
      }
    }
    for (const list of [AVALANCHE_TOKENS, MONAD_TOKENS]) {
      for (const token of list) {
        if (token.id === EVM_NATIVE_ID) continue
        expect(isValidRecipient('avalanche', token.id)).toBe(false)
        expect(isValidRecipient('monad', token.id.toLowerCase())).toBe(false)
      }
    }
    for (const token of SUI_TOKENS) {
      const address = normalizeSuiAddress(token.id.split('::')[0] as string)
      expect(isValidRecipient('sui', address)).toBe(false)
    }
  })
})

describe('sendRefusal', () => {
  it.each([
    ['solana', 'SOL'],
    ['sui', 'SUI'],
    ['near', 'wNEAR'],
    ['near', 'USDT'],
  ] as const)('refuses to move %s %s, naming what can be sent', (chain, symbol) => {
    const to = { solana: SOL_TO, sui: SUI_TO, near: NEAR_TO }[chain]
    const said = sendRefusal(chain, symbol, to)
    expect(said).toContain(`Sending ${symbol}`)
    expect(said).toContain('USDC')
    expect(said).toMatch(/ Nothing was signed or sent\.$/)
  })

  it.each([
    ['solana', 'USDC', SOL_TO],
    ['solana', 'JitoSOL', SOL_TO],
    ['solana', 'ONyc', SOL_TO],
    ['sui', 'USDsui', SUI_TO],
    ['near', 'USDC', NEAR_TO],
    ['near', 'NEAR', NEAR_TO],
    ['avalanche', 'AVAX', EVM_TO],
    ['avalanche', 'USDT', EVM_TO],
    ['monad', 'MON', EVM_TO],
    ['monad', 'USDT0', EVM_TO],
  ] as const)('lets %s send %s', (chain, symbol, to) => {
    expect(sendRefusal(chain, symbol, to)).toBeUndefined()
  })

  it('refuses a person’s own wallet, whatever the casing of a hex address', () => {
    expect(sendRefusal('avalanche', 'USDC', EVM_ME.toLowerCase(), EVM_ME)).toMatch(/your own/)
    expect(sendRefusal('solana', 'USDC', SOL_ME, SOL_ME)).toMatch(/your own/)
  })
})

describe('followOnRefusal for a send', () => {
  const venuesHere = [{ kinds: ['swap'] as const }]

  it('refuses a recipient that is not an address here, before any swap', () => {
    const said = followOnRefusal(
      'solana',
      'Solana',
      { kind: 'send', recipient: 'alice' },
      venuesHere
    )
    expect(said).toMatch(/Solana/)
    expect(said).toMatch(/ Nothing was signed or sent\.$/)
  })

  it('refuses a token this chain can’t send when it knows the swap’s output', () => {
    const said = followOnRefusal(
      'solana',
      'Solana',
      { kind: 'send', recipient: SOL_TO },
      venuesHere,
      'SOL'
    )
    expect(said).toContain('Sending SOL')
  })

  it('passes a good address', () => {
    expect(
      followOnRefusal('solana', 'Solana', { kind: 'send', recipient: SOL_TO }, venuesHere, 'USDC')
    ).toBeUndefined()
  })
})

describe('parseChainAction reads a send', () => {
  it('keeps the recipient’s case', () => {
    expect(parseChainAction(`send 5 USDC to ${SOL_TO}`)).toEqual({
      kind: 'send',
      amount: '5',
      tokenIn: 'USDC',
      recipient: SOL_TO,
    })
    expect(parseChainAction(`Please transfer 1,000.5 usdc to ${EVM_TO}.`)).toEqual({
      kind: 'send',
      amount: '1000.5',
      tokenIn: 'usdc',
      recipient: EVM_TO,
    })
  })

  it('reads a chain’s name as its token', () => {
    expect(parseChainAction(`send 2 solana to ${SOL_TO}`)).toMatchObject({ tokenIn: 'SOL' })
  })

  it('leaves the dot that ends a sentence off a NEAR account', () => {
    expect(parseChainAction('send 5 USDC to bob.near.')).toMatchObject({ recipient: 'bob.near' })
  })

  it('reads nothing that has no token or no address', () => {
    expect(parseChainAction('send 5 to bob.near')).toBeNull()
    expect(parseChainAction('send 5 USDC')).toBeNull()
    expect(parseChainAction('send 5 USDC to bob.near and carol.near')).toBeNull()
  })
})

describe('a send on Solana', () => {
  const venue = createSendVenue('solana')

  it('builds one transfer of that token and amount to that recipient, with the note', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    expect(prepared).toMatchObject({
      venueId: 'send',
      venueName: 'Wallet transfer',
      kind: 'send',
      pay: { amount: '5', symbol: 'USDC' },
    })
    expect(prepared.summary).toContain(SOL_TO)
    expect(prepared.notes).toContain(SEND_NOTE)
    expect(SEND_NOTE).toBe("Transfers can't be undone. Check the address.")
    expect(prepared.notes.join(' ')).toMatch(/rent/)
    expect(() => venue.assertSafe(prepared.signing, SOL_ME, prepared.context)).not.toThrow()
  })

  it('has no quote, and is called what the brief says', () => {
    expect(venue.id).toBe('send')
    expect(venue.name).toBe('Wallet transfer')
    expect(venue.kinds).toEqual(['send'])
    expect(venue.quote).toBeUndefined()
  })

  it('refuses another recipient, amount, token and trailing data', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    const other = async (over: Partial<ChainActionRequest>): Promise<SigningPayload> =>
      (await venue.prepare(request({ recipient: SOL_TO, ...over }), SOL_ME)).signing
    for (const payload of [
      await other({ recipient: SOL_THIEF }),
      await other({ amount: '6' }),
      await other({ tokenIn: 'USDT' }),
      { family: 'solana', transaction: solanaBytes({ extra: true }) } as const,
    ]) {
      const said = refusal(() => venue.assertSafe(payload, SOL_ME, prepared.context))
      expect(said).toMatch(/ Nothing was sent\.$/)
      expect(said).not.toMatch(/signed/)
      expect(said).not.toMatch(WORDS_FOR_A_DEPOSIT)
    }
  })

  it('refuses a recipient that is a token account, in words for a send', async () => {
    sim.accountOwner = TOKEN_PROGRAM
    const said = await refusalOf(venue.prepare(request({ recipient: SOL_TO }), SOL_ME))
    expect(said).toMatch(/token account/)
    expect(said).not.toMatch(WORDS_FOR_A_DEPOSIT)
  })

  describe('a recipient that is a program', () => {
    beforeEach(() => {
      sim.accountOwner = 'BPFLoaderUpgradeab1e11111111111111111111111'
      sim.accountExecutable = true
    })

    it('is refused at the build and before a swap, since the funds would be stranded', async () => {
      const said = await refusalOf(venue.prepare(request({ recipient: SOL_TO }), SOL_ME))
      expect(said).toMatch(/a program/)
      expect(said).toMatch(/ Nothing was signed or sent\.$/)
      expect(said).not.toMatch(WORDS_FOR_A_DEPOSIT)
      await refusalOf(
        assertFollowOnCanRun(
          moduleFor('solana'),
          { kind: 'send', tokenIn: 'USDC', recipient: SOL_TO },
          SOL_ME
        )
      )
    })

    it('changes nothing on Weave’s deposit path', async () => {
      const payload = await solanaDeposit.build({
        account: SOL_ME,
        depositAddress: SOL_TO,
        memo: undefined,
        amount: '5',
      })
      expect(payload.family).toBe('solana')
    })
  })

  it('takes a wallet with an account that is not a program', async () => {
    sim.accountOwner = SYSTEM_PROGRAM
    await expect(venue.prepare(request({ recipient: SOL_TO }), SOL_ME)).resolves.toMatchObject({
      kind: 'send',
    })
  })

  it('refuses native SOL plainly', async () => {
    expect(
      await refusalOf(venue.prepare(request({ recipient: SOL_TO, tokenIn: 'SOL' }), SOL_ME))
    ).toContain('Sending SOL')
  })

  it('refuses an EVM address and a token mint as recipient', async () => {
    await refusalOf(venue.prepare(request({ recipient: EVM_TO }), SOL_ME))
    await refusalOf(venue.prepare(request({ recipient: SOL_USDC.id }), SOL_ME))
  })
})

describe('a browser that changes what it sends back, on Solana', () => {
  const venue = createSendVenue('solana')

  async function submit(transaction: string, context: Record<string, string> | undefined) {
    return (await venue.submit?.({
      account: SOL_ME,
      venueId: venue.id,
      signed: { family: 'solana', signedTransaction: signedBytes(transaction) },
      ...(context !== undefined ? { context } : {}),
    })) as SubmitResult
  }

  it('sends what was issued', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    const result = await submit(solanaBytes(), prepared.context)
    expect(result).toMatchObject({ ok: true })
    expect(sim.rpc).toContain('sendTransaction')
  })

  it('refuses a swapped recipient in the context, and sends nothing', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    const context = { ...prepared.context, recipient: SOL_THIEF }
    expect(
      refusal(() =>
        venue.assertSafe(
          { family: 'solana', transaction: solanaBytes({ to: SOL_THIEF }) },
          SOL_ME,
          context
        )
      )
    ).toMatch(/not what this app issued/)
    const result = await submit(solanaBytes({ to: SOL_THIEF }), context)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(sim.rpc).not.toContain('sendTransaction')
  })

  it('refuses a swapped recipient in the bytes, and sends nothing', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    const result = await submit(solanaBytes({ to: SOL_THIEF }), prepared.context)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(sim.rpc).not.toContain('sendTransaction')
    if (!result.ok) expect(result.error).not.toMatch(WORDS_FOR_A_DEPOSIT)
  })

  it('refuses a context proved for another account, or with no proof, or a 1Click proof', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    const payload = { family: 'solana', transaction: solanaBytes() } as const
    expect(() => venue.assertSafe(payload, SOL_THIEF, prepared.context)).toThrow(ChainActionRefused)
    const { proof: _gone, ...unproved } = prepared.context as Record<string, string>
    expect(() => venue.assertSafe(payload, SOL_ME, unproved)).toThrow(ChainActionRefused)
    expect(() => venue.assertSafe(payload, SOL_ME, undefined)).toThrow(ChainActionRefused)
    const context = prepared.context as Record<string, string>
    const oneClick = createHmac('sha256', 'x'.repeat(48))
      .update(
        `oneclick-origin:${JSON.stringify(['send', SOL_ME, context['token'], context['amount'], SOL_TO, ''])}`
      )
      .digest('base64url')
    expect(() => venue.assertSafe(payload, SOL_ME, { ...context, proof: oneClick })).toThrow(
      ChainActionRefused
    )
  })

  it('refuses everything without the secret, since no proof can be issued or read', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    vi.stubEnv('AUTH_SECRET', '')
    await refusalOf(venue.prepare(request({ recipient: SOL_TO }), SOL_ME))
    expect(() =>
      venue.assertSafe({ family: 'solana', transaction: solanaBytes() }, SOL_ME, prepared.context)
    ).toThrow(ChainActionRefused)
    const result = await submit(solanaBytes(), prepared.context)
    expect(result).toMatchObject({ ok: false })
    expect(sim.rpc).not.toContain('sendTransaction')
  })

  it('keeps the network’s sentence about the fee, which says what to do', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    sim.send = () => ({
      error: { code: -32002, message: 'x', data: { err: 'InsufficientFundsForFee' } },
    })
    const result = await submit(solanaBytes(), prepared.context)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    if (!result.ok) expect(result.error).toMatch(/enough SOL to pay the network fee/)
  })

  it('keeps the network’s sentence about a low balance', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    sim.send = () => ({
      error: { code: -32002, message: 'x', data: { logs: ['Transfer: insufficient funds'] } },
    })
    const result = await submit(solanaBytes(), prepared.context)
    if (!result.ok) expect(result.error).toMatch(/balance is too low/)
  })

  it('rewrites only what speaks of prices', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    sim.send = () => ({ error: { code: -32002, message: 'x', data: { logs: ['custom error'] } } })
    const result = await submit(solanaBytes(), prepared.context)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) {
      expect(result.error).not.toMatch(/price/i)
      expect(result.error).toMatch(/This transfer did not go through/)
    }
  })

  it('reports a send that may have landed as pending, without a deposit’s words', async () => {
    const prepared = await venue.prepare(request({ recipient: SOL_TO }), SOL_ME)
    sim.send = () => {
      throw new Error('connection broke')
    }
    const result = await submit(solanaBytes(), prepared.context)
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) {
      expect(result.error).not.toMatch(WORDS_FOR_A_DEPOSIT)
      expect(result.error).toMatch(/don't send it again/i)
    }
    expect(afterSubmitting(result, 'solana')).toMatchObject({ phase: 'pending', latched: true })
  })
})

describe('a send on Sui', () => {
  const venue = createSendVenue('sui')

  it('builds one transfer and checks it', async () => {
    const prepared = await venue.prepare(request({ recipient: SUI_TO }), SUI_ME)
    expect(prepared.summary).toContain(SUI_TO)
    expect(prepared.notes).toContain(SEND_NOTE)
    expect(() => venue.assertSafe(prepared.signing, SUI_ME, prepared.context)).not.toThrow()
  })

  it('refuses another recipient, amount, token and trailing data', async () => {
    const prepared = await venue.prepare(request({ recipient: SUI_TO }), SUI_ME)
    const other = async (over: Partial<ChainActionRequest>): Promise<SigningPayload> =>
      (await venue.prepare(request({ recipient: SUI_TO, ...over }), SUI_ME)).signing
    for (const payload of [
      await other({ recipient: SUI_THIEF }),
      await other({ amount: '6' }),
      { family: 'sui', transaction: await suiBytes({ extra: true }) } as const,
    ]) {
      expect(refusal(() => venue.assertSafe(payload, SUI_ME, prepared.context))).not.toMatch(
        WORDS_FOR_A_DEPOSIT
      )
    }
    const usdt = await venue.prepare(request({ recipient: SUI_TO, tokenIn: 'USDT' }), SUI_ME)
    // The bytes name a coin by id alone, so another token shows at the amount's proof or at submit.
    expect(() => venue.assertSafe(usdt.signing, SUI_ME, usdt.context)).not.toThrow()
    expect(usdt.context?.['token']).not.toBe(prepared.context?.['token'])
    core.getObjects.mockImplementation(async ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map((id) => coinObject(id, tokenBySymbol(SUI_TOKENS, 'USDT')?.id)),
    }))
    const result = (await venue.submit?.({
      account: SUI_ME,
      venueId: venue.id,
      signed: { family: 'sui', transaction: await suiBytes(), signature: 'sig' },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    })) as SubmitResult
    expect(result).toMatchObject({ ok: false })
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('refuses native SUI plainly, and words a thin wallet for a send', async () => {
    expect(
      await refusalOf(venue.prepare(request({ recipient: SUI_TO, tokenIn: 'SUI' }), SUI_ME))
    ).toContain('Sending SUI')
    core.listCoins.mockResolvedValue({ objects: [], hasNextPage: false, cursor: null })
    core.getBalance.mockResolvedValue({ balance: { balance: '0' } })
    const said = await refusalOf(venue.prepare(request({ recipient: SUI_TO }), SUI_ME))
    expect(said).toMatch(/holds less USDC/)
    expect(said).not.toMatch(WORDS_FOR_A_DEPOSIT)
  })

  it('refuses a Solana address', async () => {
    await refusalOf(venue.prepare(request({ recipient: SOL_TO }), SUI_ME))
  })

  it('says a failed read after signing sent nothing, and claims nothing about signing', async () => {
    const prepared = await venue.prepare(request({ recipient: SUI_TO }), SUI_ME)
    core.getObjects.mockRejectedValue(new Error('rpc blip'))
    const result = (await venue.submit?.({
      account: SUI_ME,
      venueId: venue.id,
      signed: { family: 'sui', transaction: await suiBytes(), signature: 'sig' },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    })) as SubmitResult
    expect(result).toEqual({
      ok: false,
      error: 'This transfer was not sent, so nothing left your wallet. You can try again.',
    })
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })

  it('rewrites a failure on the network, which a trade’s or deposit’s words would misname', async () => {
    const prepared = await venue.prepare(request({ recipient: SUI_TO }), SUI_ME)
    core.executeTransaction.mockResolvedValue({
      FailedTransaction: { digest: 'DIGESTx', effects: { status: { success: false } } },
    })
    const result = (await venue.submit?.({
      account: SUI_ME,
      venueId: venue.id,
      signed: { family: 'sui', transaction: await suiBytes(), signature: 'sig' },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    })) as SubmitResult
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).not.toMatch(WORDS_FOR_A_DEPOSIT)
  })

  it('refuses a browser’s swapped recipient, in the context or in the bytes', async () => {
    const prepared = await venue.prepare(request({ recipient: SUI_TO }), SUI_ME)
    const bytes = await suiBytes({ to: SUI_THIEF })
    const payload = { family: 'sui', transaction: bytes } as const
    expect(() =>
      venue.assertSafe(payload, SUI_ME, { ...prepared.context, recipient: SUI_THIEF })
    ).toThrow(/not what this app issued/)
    expect(() => venue.assertSafe(payload, SUI_ME, prepared.context)).toThrow(ChainActionRefused)
    const result = (await venue.submit?.({
      account: SUI_ME,
      venueId: venue.id,
      signed: { family: 'sui', transaction: bytes, signature: 'sig' },
      ...(prepared.context !== undefined ? { context: prepared.context } : {}),
    })) as SubmitResult
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
    expect(core.executeTransaction).not.toHaveBeenCalled()
  })
})

describe.each([
  ['avalanche', AVALANCHE_TOKENS, 'AVAX', 43114],
  ['monad', MONAD_TOKENS, 'MON', 143],
] as const)('a send on %s', (chain, tokens, native, chainId) => {
  const venue = createSendVenue(chain)
  const usdc = tokenBySymbol(tokens, 'USDC') as ChainToken

  it('builds one ERC-20 transfer, and refuses another of anything', async () => {
    const prepared = await venue.prepare(request({ recipient: EVM_TO }), EVM_ME)
    expect(prepared.signing).toMatchObject({ family: 'evm', chainId, to: usdc.id, value: '0' })
    expect(prepared.summary).toContain(EVM_TO)
    expect(prepared.notes).toContain(SEND_NOTE)
    expect(() => venue.assertSafe(prepared.signing, EVM_ME, prepared.context)).not.toThrow()

    const other = async (over: Partial<ChainActionRequest>): Promise<SigningPayload> =>
      (await venue.prepare(request({ recipient: EVM_TO, ...over }), EVM_ME)).signing
    const signing = prepared.signing as Extract<SigningPayload, { family: 'evm' }>
    for (const payload of [
      await other({ recipient: EVM_THIEF }),
      await other({ amount: '6' }),
      await other({ tokenIn: native }),
      { ...signing, data: `${signing.data}00` },
    ]) {
      expect(refusal(() => venue.assertSafe(payload, EVM_ME, prepared.context))).not.toMatch(
        WORDS_FOR_A_DEPOSIT
      )
    }
  })

  it('moves the native coin to the recipient, with no data', async () => {
    const prepared = await venue.prepare(request({ recipient: EVM_TO, tokenIn: native }), EVM_ME)
    expect(prepared.signing).toEqual({
      family: 'evm',
      chainId,
      to: EVM_TO,
      data: '0x',
      value: '5000000000000000000',
    })
    expect(() => venue.assertSafe(prepared.signing, EVM_ME, prepared.context)).not.toThrow()
  })

  it('refuses a token contract, a wrong checksum and a Solana address', async () => {
    await refusalOf(venue.prepare(request({ recipient: usdc.id }), EVM_ME))
    await refusalOf(venue.prepare(request({ recipient: `0x${'B2'.repeat(19)}b2` }), EVM_ME))
    await refusalOf(venue.prepare(request({ recipient: SOL_TO }), EVM_ME))
  })

  it('refuses more than the wallet holds, in words for a send', async () => {
    rpc.tokenBalance = async () => BigInt(1)
    const said = await refusalOf(venue.prepare(request({ recipient: EVM_TO }), EVM_ME))
    expect(said).toMatch(/holds less USDC/)
    expect(said).not.toMatch(WORDS_FOR_A_DEPOSIT)
  })
})

describe('a browser that changes what it sends back, on EVM', () => {
  const venue = createSendVenue('avalanche')

  async function submit(context: Record<string, string> | undefined): Promise<SubmitResult> {
    return (await venue.submit?.({
      account: EVM_ME,
      venueId: venue.id,
      signed: { family: 'evm', hash: EVM_HASH },
      ...(context !== undefined ? { context } : {}),
    })) as SubmitResult
  }

  const paid = (to: string) => ({
    status: 'success',
    from: EVM_ME,
    to: AVAX_USDC.id,
    logs: [transferLog(to, BigInt(5_000_000))],
  })

  it('confirms the issued transfer from the chain', async () => {
    const prepared = await venue.prepare(request({ recipient: EVM_TO }), EVM_ME)
    rpc.waitForReceipt = async () => paid(EVM_TO)
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: true, hash: EVM_HASH })
  })

  it('never confirms a recipient swapped in the context, and holds the latch', async () => {
    const prepared = await venue.prepare(request({ recipient: EVM_TO }), EVM_ME)
    rpc.waitForReceipt = async () => paid(EVM_THIEF)
    const result = await submit({ ...prepared.context, recipient: EVM_THIEF })
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) expect(result.error).not.toMatch(WORDS_FOR_A_DEPOSIT)
    expect(afterSubmitting(result, 'evm')).toMatchObject({ phase: 'pending', latched: true })
  })

  it('never confirms a chain that paid someone else', async () => {
    const prepared = await venue.prepare(request({ recipient: EVM_TO }), EVM_ME)
    rpc.waitForReceipt = async () => paid(EVM_THIEF)
    const result = await submit(prepared.context)
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) expect(result.error).not.toMatch(WORDS_FOR_A_DEPOSIT)
  })

  it('never confirms a native send to someone else', async () => {
    const prepared = await venue.prepare(request({ recipient: EVM_TO, tokenIn: 'AVAX' }), EVM_ME)
    rpc.waitForReceipt = async () => ({ status: 'success', from: EVM_ME, to: EVM_THIEF, logs: [] })
    rpc.transaction = async () => ({ value: BigInt('5000000000000000000'), input: '0x' })
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: false, pending: true })
  })

  it('reads as pending without the secret, since the wallet has already sent', async () => {
    const prepared = await venue.prepare(request({ recipient: EVM_TO }), EVM_ME)
    vi.stubEnv('AUTH_SECRET', '')
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: false, pending: true })
  })
})

describe('a send on NEAR', () => {
  const venue = createSendVenue('near')

  it('builds one ft_transfer on USDC to a named account, with no storage action', async () => {
    const prepared = await venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME)
    expect(prepared.signing).toEqual({
      family: 'near',
      transactions: [
        {
          receiverId: USDC_NEAR,
          actions: [
            {
              type: 'FunctionCall',
              params: {
                methodName: 'ft_transfer',
                args: { receiver_id: NEAR_TO, amount: '5000000' },
                gas: TRANSFER_GAS.toString(),
                deposit: '1',
              },
            },
          ],
        },
      ],
    })
    expect(prepared.summary).toContain(NEAR_TO)
    expect(prepared.notes).toContain(SEND_NOTE)
    expect(() => venue.assertSafe(prepared.signing, NEAR_ME, prepared.context)).not.toThrow()
  })

  it('leaves a 1Click deposit’s check as strict as it was, whatever a venue passes it', async () => {
    const prepared = await venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME)
    const asVenue: (p: SigningPayload, a: string, c?: Record<string, string>) => void =
      assertOneClickSafe
    expect(() => asVenue(prepared.signing, NEAR_ME, { depositAddress: 'x' })).toThrow(
      /does not go to a deposit address/
    )
  })

  it('takes an implicit account too', async () => {
    const prepared = await venue.prepare(request({ recipient: 'a'.repeat(64) }), NEAR_ME)
    expect(() => venue.assertSafe(prepared.signing, NEAR_ME, prepared.context)).not.toThrow()
  })

  it('refuses a receiver not registered with the token, in a plain sentence', async () => {
    vi.mocked(isRegistered).mockResolvedValue(false)
    const said = await refusalOf(venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME))
    expect(said).toContain(NEAR_TO)
    expect(said).toMatch(/registered/)
    expect(said).toMatch(/ Nothing was signed or sent\.$/)
    expect(said).not.toContain('—')
  })

  it('refuses when registration can’t be read, rather than guess', async () => {
    vi.mocked(isRegistered).mockRejectedValue(new Error('rpc down'))
    const said = await refusalOf(venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME))
    expect(said).toMatch(/could not be read/)
  })

  it('refuses another recipient, amount, token, a storage action and extra arguments', async () => {
    const prepared = await venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME)
    const base = prepared.signing as Extract<SigningPayload, { family: 'near' }>
    const tx = base.transactions[0] as (typeof base.transactions)[number]
    const action = tx.actions[0] as NearFunctionCall
    const withArgs = (args: Record<string, unknown>): SigningPayload => ({
      family: 'near',
      transactions: [{ ...tx, actions: [{ ...action, params: { ...action.params, args } }] }],
    })
    const storage = {
      type: 'FunctionCall' as const,
      params: {
        methodName: 'storage_deposit',
        args: { account_id: NEAR_TO, registration_only: true },
        gas: TRANSFER_GAS.toString(),
        deposit: '1250000000000000000000',
      },
    }
    for (const payload of [
      withArgs({ receiver_id: NEAR_THIEF, amount: '5000000' }),
      withArgs({ receiver_id: NEAR_TO, amount: '6000000' }),
      withArgs({ receiver_id: NEAR_TO, amount: '5000000', memo: 'x' }),
      { family: 'near', transactions: [{ ...tx, receiverId: USDT_NEAR }] } as const,
      { family: 'near', transactions: [{ ...tx, actions: [storage, action] }] } as const,
      { family: 'near', transactions: [tx, tx] } as const,
    ] as SigningPayload[]) {
      expect(() => venue.assertSafe(payload, NEAR_ME, prepared.context)).toThrow(ChainActionRefused)
    }
  })

  it('refuses every token but USDC and NEAR, wrapped NEAR included', async () => {
    expect(
      await refusalOf(venue.prepare(request({ recipient: NEAR_TO, tokenIn: 'wNEAR' }), NEAR_ME))
    ).toContain('Sending wNEAR')
    expect(
      await refusalOf(venue.prepare(request({ recipient: NEAR_TO, tokenIn: 'USDT' }), NEAR_ME))
    ).toContain('Sending USDT')
  })

  it('refuses a token contract as recipient', async () => {
    await refusalOf(venue.prepare(request({ recipient: WRAP_NEAR }), NEAR_ME))
    await refusalOf(venue.prepare(request({ recipient: USDC_NEAR }), NEAR_ME))
  })

  async function submit(context: Record<string, string> | undefined): Promise<SubmitResult> {
    return (await venue.submit?.({
      account: NEAR_ME,
      venueId: venue.id,
      signed: { family: 'near', hashes: [NEAR_HASH] },
      ...(context !== undefined ? { context } : {}),
    })) as SubmitResult
  }

  const called = (to: string, amount = '5000000') => ({
    signer: NEAR_ME,
    receiver: USDC_NEAR,
    calls: [{ method: 'ft_transfer', args: { receiver_id: to, amount }, deposit: '1' }],
  })

  it('confirms what the chain shows', async () => {
    const prepared = await venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME)
    vi.mocked(waitForTransaction).mockResolvedValue({ state: 'success', ...called(NEAR_TO) })
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: true, hash: NEAR_HASH })
  })

  it('never confirms a recipient swapped in the context', async () => {
    const prepared = await venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME)
    vi.mocked(waitForTransaction).mockResolvedValue({ state: 'success', ...called(NEAR_THIEF) })
    const result = await submit({ ...prepared.context, recipient: NEAR_THIEF })
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) expect(result.error).not.toMatch(WORDS_FOR_A_DEPOSIT)
  })

  it('reads a chain that paid someone else as pending, since the wallet has already sent', async () => {
    const prepared = await venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME)
    vi.mocked(waitForTransaction).mockResolvedValue({ state: 'success', ...called(NEAR_THIEF) })
    const result = await submit(prepared.context)
    expect(result).toMatchObject({ ok: false, pending: true })
    if (!result.ok) expect(result.error).not.toMatch(WORDS_FOR_A_DEPOSIT)
  })

  it('reads a failed hash as pending too: it might not be this transfer', async () => {
    const prepared = await venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME)
    vi.mocked(waitForTransaction).mockResolvedValue({ state: 'failed', ...called(NEAR_THIEF) })
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: false, pending: true })
  })
})

describe('prepareChainAction on a send', () => {
  it('needs a recipient for a send, and takes none for anything else', async () => {
    const solana = moduleFor('solana')
    await refusalOf(prepareChainAction(solana, request({}), SOL_ME))
    const said = await refusalOf(
      prepareChainAction(
        moduleFor('solana', {
          venues: [{ ...createSendVenue('solana'), kinds: ['swap'] }, createSendVenue('solana')],
          defaultVenue: { swap: 'send', send: 'send' },
        }),
        { kind: 'swap', amount: '5', tokenIn: 'USDC', tokenOut: 'USDT', recipient: SOL_TO },
        SOL_ME
      )
    )
    expect(said).toMatch(/doesn't take an address/i)
  })

  it('keeps the fee reserve on a native send', async () => {
    const said = await refusalOf(
      prepareChainAction(
        moduleFor('avalanche', {
          balances: async () => ({
            tokens: [
              {
                symbol: 'AVAX',
                id: EVM_NATIVE_ID,
                amount: '5',
                decimals: 18,
                native: true,
                listed: true,
              },
            ],
            complete: true,
          }),
        }),
        request({ recipient: EVM_TO, tokenIn: 'AVAX' }),
        EVM_ME
      )
    )
    expect(said).toMatch(/Keep about 0\.01 AVAX/)
  })

  describe('what the wallet holds', () => {
    const held = (amount: string, id = AVAX_USDC.id, symbol = 'USDC') => ({
      symbol,
      id,
      amount,
      decimals: 6,
      native: false,
      listed: true,
    })
    const send = (amount: string, chain: ChainModule): Promise<PreparedAction> =>
      prepareChainAction(chain, request({ amount, recipient: EVM_TO }), EVM_ME)

    it('refuses a known shortfall in a plain sentence', async () => {
      const chain = moduleFor('avalanche', {
        balances: async () => ({ tokens: [held('5')], complete: false }),
      })
      expect(await refusalOf(send('50', chain))).toBe(
        'You hold 5 USDC, which is less than 50. Nothing was signed or sent.'
      )
    })

    it('reads the token by id, never by a symbol anyone can copy', async () => {
      const chain = moduleFor('avalanche', {
        balances: async () => ({
          tokens: [held('999', `0x${'9'.repeat(40)}`), held('5')],
          complete: false,
        }),
      })
      expect(await refusalOf(send('50', chain))).toMatch(/You hold 5 USDC/)
    })

    it('counts a token missing from an answer that lists everything as none held', async () => {
      const chain = moduleFor('avalanche', {
        balances: async () => ({ tokens: [], complete: true }),
      })
      expect(await refusalOf(send('50', chain))).toMatch(/You hold 0 USDC/)
    })

    it('passes exactly what is held', async () => {
      const chain = moduleFor('avalanche', {
        balances: async () => ({ tokens: [held('50')], complete: false }),
      })
      await expect(send('50', chain)).resolves.toMatchObject({ kind: 'send' })
    })

    it('passes when the read fails or says nothing about the token', async () => {
      for (const balances of [
        async () => {
          throw new Error('rpc down')
        },
        async () => ({ tokens: [], complete: false }),
        async () => ({ tokens: [], complete: true, unread: ['USDC'] }),
      ]) {
        await expect(send('50', moduleFor('avalanche', { balances }))).resolves.toMatchObject({
          kind: 'send',
        })
      }
    })

    it('passes a read that takes too long, without waiting on the chain', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const working = send(
          '50',
          moduleFor('avalanche', { balances: () => new Promise(() => undefined) })
        )
        await vi.advanceTimersByTimeAsync(3_000)
        await expect(working).resolves.toMatchObject({ kind: 'send' })
      } finally {
        vi.useRealTimers()
      }
    })

    it('reads a native send once, leaving it to the reserve check', async () => {
      const balances = vi.fn(async () => ({ tokens: [], complete: false }))
      await prepareChainAction(
        moduleFor('avalanche', { balances }),
        request({ tokenIn: 'AVAX', recipient: EVM_TO }),
        EVM_ME
      )
      expect(balances).toHaveBeenCalledTimes(1)
    })

    it('reads nothing for anything but a send', async () => {
      const balances = vi.fn(async () => ({ tokens: [], complete: true }))
      const venue = {
        id: 'lend',
        name: 'Lend',
        kinds: ['supply'] as const,
        prepare: async () => ({ kind: 'supply' }) as PreparedAction,
        assertSafe: () => undefined,
      }
      await prepareChainAction(
        moduleFor('avalanche', { balances, venues: [venue], defaultVenue: { supply: 'lend' } }),
        { kind: 'supply', amount: '50', tokenIn: 'USDC' },
        EVM_ME
      )
      expect(balances).not.toHaveBeenCalled()
    })
  })

  it('says native SOL can’t move before it says anything about the reserve', async () => {
    const balances = vi.fn(async () => ({ tokens: [], complete: true }))
    const said = await refusalOf(
      prepareChainAction(
        moduleFor('solana', { balances }),
        request({ recipient: SOL_TO, tokenIn: 'SOL' }),
        SOL_ME
      )
    )
    expect(said).toContain('Sending SOL')
    expect(balances).not.toHaveBeenCalled()
  })

  it('builds and checks through the whole path', async () => {
    const prepared: PreparedAction = await prepareChainAction(
      moduleFor('avalanche'),
      request({ recipient: EVM_TO }),
      EVM_ME
    )
    expect(prepared.kind).toBe('send')
    expect(prepared.context?.['recipient']).toBe(EVM_TO)
  })
})

describe('the race', () => {
  it('goes straight to the card for a typed send, and only for a send', () => {
    expect(racesFirst({ kind: 'send' })).toBe(false)
    for (const kind of ['swap', 'supply', 'stake'] as const) {
      expect(racesFirst({ kind })).toBe(true)
    }
  })

  it('never takes a send', async () => {
    await expect(
      quoteChainRoutes(moduleFor('solana'), request({ recipient: SOL_TO }), SOL_ME)
    ).resolves.toEqual([])
  })
})

describe('where the send venue is offered', () => {
  const KEY = { AUTH_SECRET: 'x'.repeat(48) }

  it('is on every chain when a proof can be issued, as the default for a send', () => {
    expect(buildSolanaVenues(KEY).map((v) => v.id)).toContain('send')
    expect(buildSuiVenues(KEY).map((v) => v.id)).toContain('send')
    expect(buildNearVenues(KEY).map((v) => v.id)).toContain('send')
    expect(buildEvmVenues('avalanche', KEY).map((v) => v.id)).toContain('send')
    expect(buildEvmVenues('monad', KEY).map((v) => v.id)).toContain('send')
    for (const chain of [solanaModule, suiModule, nearModule, avalancheModule, monadModule]) {
      expect(chain.defaultVenue.send).toBe('send')
    }
  })

  it('is on no chain without the secret', () => {
    for (const list of [
      buildSolanaVenues({}),
      buildSuiVenues({}),
      buildNearVenues({}),
      buildEvmVenues('avalanche', {}),
      buildEvmVenues('monad', { AUTH_SECRET: 'short' }),
    ]) {
      expect(list.map((v) => v.id)).not.toContain('send')
    }
  })

  it('is not an app, so the Apps list has no entry and needs no logo', () => {
    expect(venues.map((v) => v.id)).not.toContain('send')
  })
})

describe('assertFollowOnCanRun', () => {
  const step = (over: Partial<Parameters<typeof assertFollowOnCanRun>[1]>) =>
    ({ kind: 'send', tokenIn: 'USDC', ...over }) as Parameters<typeof assertFollowOnCanRun>[1]

  it('passes a send that could run, and reads nothing it does not need', async () => {
    await expect(
      assertFollowOnCanRun(moduleFor('solana'), step({ recipient: SOL_TO }), SOL_ME)
    ).resolves.toBeUndefined()
  })

  it('refuses before the swap a NEAR receiver not registered with the token', async () => {
    vi.mocked(isRegistered).mockResolvedValue(false)
    const said = await refusalOf(
      assertFollowOnCanRun(moduleFor('near'), step({ recipient: NEAR_TO }), NEAR_ME)
    )
    expect(said).toMatch(/registered/)
  })

  it('refuses before the swap a Solana recipient that is a token account', async () => {
    sim.accountOwner = TOKEN_PROGRAM
    const said = await refusalOf(
      assertFollowOnCanRun(moduleFor('solana'), step({ recipient: SOL_TO }), SOL_ME)
    )
    expect(said).toMatch(/token account/)
  })

  it('refuses a token that can’t be sent, and no send venue at all', async () => {
    expect(
      await refusalOf(
        assertFollowOnCanRun(
          moduleFor('solana'),
          step({ recipient: SOL_TO, tokenIn: 'SOL' }),
          SOL_ME
        )
      )
    ).toContain('Sending SOL')
    expect(
      await refusalOf(
        assertFollowOnCanRun(
          moduleFor('solana', { venues: [] }),
          step({ recipient: SOL_TO }),
          SOL_ME
        )
      )
    ).toMatch(/Nothing here can send/)
  })

  it('reads the real venues: what each supply and stake takes after a swap', async () => {
    const onSui = suiModule
    await expect(
      assertFollowOnCanRun(onSui, step({ kind: 'supply' }), SUI_ME)
    ).resolves.toBeUndefined()
    await expect(
      assertFollowOnCanRun(onSui, step({ kind: 'stake', tokenIn: 'SUI' }), SUI_ME)
    ).resolves.toBeUndefined()
    expect(await refusalOf(assertFollowOnCanRun(onSui, step({ kind: 'stake' }), SUI_ME))).toMatch(
      /SpringSui takes SUI/
    )
    expect(
      await refusalOf(
        assertFollowOnCanRun(onSui, step({ kind: 'supply', tokenIn: 'USDT' }), SUI_ME)
      )
    ).toMatch(/NAVI takes USDC/)

    const onSolana = solanaModule
    await expect(
      assertFollowOnCanRun(onSolana, step({ kind: 'supply', tokenIn: 'USDT' }), SOL_ME)
    ).resolves.toBeUndefined()
    expect(
      await refusalOf(
        assertFollowOnCanRun(
          onSolana,
          step({ kind: 'supply', tokenIn: 'USDT', venue: 'kamino' }),
          SOL_ME
        )
      )
    ).toMatch(/Kamino takes USDC/)
    expect(
      await refusalOf(
        assertFollowOnCanRun(onSolana, step({ kind: 'supply', venue: 'nowhere' }), SOL_ME)
      )
    ).toMatch(/"nowhere" can't supply here/)

    await expect(
      assertFollowOnCanRun(nearModule, step({ kind: 'supply', tokenIn: 'USDT' }), NEAR_ME)
    ).resolves.toBeUndefined()
  })

  it('lets a stake follow a swap that ends in NEAR, and nothing else', async () => {
    await expect(
      assertFollowOnCanRun(nearModule, step({ kind: 'stake', tokenIn: 'NEAR' }), NEAR_ME)
    ).resolves.toBeUndefined()
    const said = await refusalOf(
      assertFollowOnCanRun(nearModule, step({ kind: 'stake', tokenIn: 'USDC' }), NEAR_ME)
    )
    expect(said).toMatch(/takes NEAR/)
  })

  it('refuses a token this chain does not list', async () => {
    await refusalOf(
      assertFollowOnCanRun(
        moduleFor('solana'),
        step({ recipient: SOL_TO, tokenIn: 'SCAM' }),
        SOL_ME
      )
    )
  })
})

function post(body: unknown): Request {
  return new Request('http://localhost/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('the prepare route', () => {
  const params = { params: Promise.resolve({ chain: 'avalanche' }) }

  beforeEach(() => {
    vi.mocked(chainModule).mockReturnValue(moduleFor('avalanche'))
  })

  it('carries the recipient exactly as typed', async () => {
    const reply = await PREPARE(
      post({
        account: EVM_ME,
        request: { kind: 'send', amount: '5', tokenIn: 'USDC', recipient: EVM_TO },
      }),
      params
    )
    expect(reply.status).toBe(200)
    const { prepared } = (await reply.json()) as { prepared: PreparedAction }
    expect(prepared.context?.['recipient']).toBe(EVM_TO)
  })

  it('refuses a send with no recipient', async () => {
    const reply = await PREPARE(
      post({ account: EVM_ME, request: { kind: 'send', amount: '5', tokenIn: 'USDC' } }),
      params
    )
    expect(reply.status).toBe(422)
  })

  it('refuses a recipient on anything but a send', async () => {
    const reply = await PREPARE(
      post({
        account: EVM_ME,
        request: { kind: 'supply', amount: '5', tokenIn: 'USDC', recipient: EVM_TO },
      }),
      params
    )
    expect(reply.status).toBe(422)
  })

  it('refuses an oversized recipient at the door', async () => {
    const reply = await PREPARE(
      post({
        account: EVM_ME,
        request: { kind: 'send', amount: '5', tokenIn: 'USDC', recipient: 'x'.repeat(129) },
      }),
      params
    )
    expect(reply.status).toBe(400)
  })
})

describe('the follow-on route', () => {
  const params = { params: Promise.resolve({ chain: 'near' }) }

  beforeEach(() => {
    vi.mocked(chainModule).mockReturnValue(moduleFor('near'))
  })

  it('answers ok for a step that can run', async () => {
    const reply = await FOLLOW_ON(
      post({
        account: NEAR_ME,
        step: { kind: 'send', tokenIn: 'USDC', recipient: NEAR_TO },
      }),
      params
    )
    expect(reply.status).toBe(200)
    await expect(reply.json()).resolves.toEqual({ ok: true })
  })

  it('gives the sentence for one that can’t, ending the way every refusal does', async () => {
    vi.mocked(isRegistered).mockResolvedValue(false)
    const reply = await FOLLOW_ON(
      post({
        account: NEAR_ME,
        step: { kind: 'send', tokenIn: 'USDC', recipient: NEAR_TO },
      }),
      params
    )
    expect(reply.status).toBe(422)
    const { error } = (await reply.json()) as { error: string }
    expect(error).toMatch(/registered/)
    expect(error).toMatch(/ Nothing was signed or sent\.$/)
  })

  it('adds the ending where a shared sentence has none', async () => {
    const reply = await FOLLOW_ON(
      post({ account: NEAR_ME, step: { kind: 'stake', tokenIn: 'NEAR' } }),
      params
    )
    expect(reply.status).toBe(422)
    const { error } = (await reply.json()) as { error: string }
    expect(error).toMatch(/ Nothing was signed or sent\.$/)
  })

  it('takes no swap', async () => {
    const reply = await FOLLOW_ON(
      post({ account: NEAR_ME, step: { kind: 'swap', tokenIn: 'USDC' } }),
      params
    )
    expect(reply.status).toBe(400)
  })
})

describe('a send of native NEAR', () => {
  const venue = createSendVenue('near')
  const TWO_AND_A_HALF = '2500000000000000000000000'
  const nearSend = (over: Partial<ChainActionRequest> = {}): ChainActionRequest =>
    request({ recipient: NEAR_TO, tokenIn: 'NEAR', amount: '2.5', ...over })

  beforeEach(() => {
    vi.mocked(accountBalance).mockReset()
    vi.mocked(accountBalance).mockResolvedValue('1')
  })

  const paying = (to: string, deposit: string): SigningPayload => ({
    family: 'near',
    transactions: [{ receiverId: to, actions: [{ type: 'Transfer', params: { deposit } }] }],
  })

  it('builds one Transfer to the recipient, for exactly the amount', async () => {
    const prepared = await venue.prepare(nearSend(), NEAR_ME)
    expect(prepared.signing).toEqual(paying(NEAR_TO, TWO_AND_A_HALF))
    expect(prepared.summary).toBe(`Send 2.5 NEAR to ${NEAR_TO}.`)
    expect(prepared.notes).toContain(SEND_NOTE)
    expect(() => venue.assertSafe(prepared.signing, NEAR_ME, prepared.context)).not.toThrow()
  })

  it('never asks a NEP-141 contract for NEAR, since that would move wNEAR', async () => {
    const prepared = await venue.prepare(nearSend(), NEAR_ME)
    const near = prepared.signing as Extract<SigningPayload, { family: 'near' }>
    expect(near.transactions[0]?.receiverId).not.toBe(WRAP_NEAR)
  })

  it('refuses a named account that does not exist, naming it', async () => {
    vi.mocked(accountBalance).mockRejectedValue(new NearRpcError('UNKNOWN_ACCOUNT'))
    const said = await refusalOf(venue.prepare(nearSend(), NEAR_ME))
    expect(said).toContain(NEAR_TO)
    expect(said).toMatch(/doesn.t exist/)
    expect(said).toMatch(/ Nothing was signed or sent\.$/)
  })

  it('refuses when a named account can’t be read, rather than guess', async () => {
    vi.mocked(accountBalance).mockRejectedValue(new Error('rpc down'))
    expect(await refusalOf(venue.prepare(nearSend(), NEAR_ME))).toMatch(/could not be read/)
  })

  it('takes an implicit account without reading it, since one exists once it is funded', async () => {
    const implicit = 'a'.repeat(64)
    const prepared = await venue.prepare(nearSend({ recipient: implicit }), NEAR_ME)
    expect(prepared.signing).toEqual(paying(implicit, TWO_AND_A_HALF))
    expect(accountBalance).not.toHaveBeenCalled()
  })

  it('refuses another recipient, another amount, or anything added to the transfer', async () => {
    const prepared = await venue.prepare(nearSend(), NEAR_ME)
    const good = paying(NEAR_TO, TWO_AND_A_HALF) as Extract<SigningPayload, { family: 'near' }>
    const tx = good.transactions[0] as (typeof good.transactions)[number]
    const call = {
      type: 'FunctionCall' as const,
      params: { methodName: 'x', args: {}, gas: '1', deposit: '0' },
    }
    for (const payload of [
      paying(NEAR_THIEF, TWO_AND_A_HALF),
      paying(NEAR_TO, '2500000000000000000000001'),
      paying(NEAR_ME, TWO_AND_A_HALF),
      { family: 'near', transactions: [tx, tx] },
      { family: 'near', transactions: [{ ...tx, actions: [...tx.actions, call] }] },
      { family: 'near', transactions: [{ ...tx, actions: [...tx.actions, ...tx.actions] }] },
      { family: 'near', transactions: [{ ...tx, signerId: NEAR_THIEF }] },
      {
        family: 'near',
        transactions: [
          { ...tx, actions: [{ type: 'Transfer', params: { deposit: TWO_AND_A_HALF, x: 1 } }] },
        ],
      },
      { family: 'near', transactions: [{ ...tx, actions: [call] }] },
    ] as SigningPayload[]) {
      expect(() => venue.assertSafe(payload, NEAR_ME, prepared.context)).toThrow(ChainActionRefused)
    }
  })

  it('refuses a Transfer on every path that is not this one', async () => {
    const usdc = await venue.prepare(request({ recipient: NEAR_TO }), NEAR_ME)
    expect(() => venue.assertSafe(paying(NEAR_TO, '5000000'), NEAR_ME, usdc.context)).toThrow(
      ChainActionRefused
    )
    expect(() => assertOneClickSafe(paying('a'.repeat(64), '5000000'), NEAR_ME)).toThrow(
      /something other than a contract call/
    )
  })

  async function submit(context: Record<string, string> | undefined): Promise<SubmitResult> {
    return (await venue.submit?.({
      account: NEAR_ME,
      venueId: venue.id,
      signed: { family: 'near', hashes: [NEAR_HASH] },
      ...(context !== undefined ? { context } : {}),
    })) as SubmitResult
  }

  const moved = (receiver: string, deposit: string, signer = NEAR_ME) => ({
    signer,
    receiver,
    calls: [],
    transfers: [deposit],
  })

  it('confirms what the chain shows', async () => {
    const prepared = await venue.prepare(nearSend(), NEAR_ME)
    vi.mocked(waitForTransaction).mockResolvedValue({
      state: 'success',
      ...moved(NEAR_TO, TWO_AND_A_HALF),
    })
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: true, hash: NEAR_HASH })
  })

  it.each([
    ['another receiver', moved(NEAR_THIEF, TWO_AND_A_HALF)],
    ['another amount', moved(NEAR_TO, '1')],
    ['another signer', moved(NEAR_TO, TWO_AND_A_HALF, NEAR_THIEF)],
    ['no transfer at all', { signer: NEAR_ME, receiver: NEAR_TO, calls: [], transfers: [] }],
  ])('never confirms %s, and reads it as pending', async (_name, outcome) => {
    const prepared = await venue.prepare(nearSend(), NEAR_ME)
    vi.mocked(waitForTransaction).mockResolvedValue({ state: 'success', ...outcome })
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: false, pending: true })
  })

  it('reads a failed or unseen transaction as pending', async () => {
    const prepared = await venue.prepare(nearSend(), NEAR_ME)
    vi.mocked(waitForTransaction).mockResolvedValue({
      state: 'failed',
      ...moved(NEAR_TO, TWO_AND_A_HALF),
    })
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: false, pending: true })
    vi.mocked(waitForTransaction).mockResolvedValue({ state: 'unknown' })
    await expect(submit(prepared.context)).resolves.toMatchObject({ ok: false, pending: true })
  })

  it('can follow a swap to NEAR, checked against the real recipient', async () => {
    await expect(
      venue.assertCanFollow?.({ kind: 'send', tokenIn: 'NEAR', recipient: NEAR_TO }, NEAR_ME)
    ).resolves.toBeUndefined()
    vi.mocked(accountBalance).mockRejectedValue(new NearRpcError('UNKNOWN_ACCOUNT'))
    await expect(
      venue.assertCanFollow?.({ kind: 'send', tokenIn: 'NEAR', recipient: NEAR_TO }, NEAR_ME)
    ).rejects.toThrow(/doesn.t exist/)
  })
})

describe('a step after a swap that spends the native coin', () => {
  const holding = (amount: string) => ({
    ...nearModule,
    balances: async () => ({
      account: NEAR_ME,
      complete: true,
      tokens: [{ symbol: 'NEAR', id: 'near', amount, decimals: 24, native: true, listed: true }],
    }),
  })

  it('refuses before the swap is signed when too little is left for fees', async () => {
    const said = await refusalOf(
      assertFollowOnCanRun(
        holding('0.02') as unknown as typeof nearModule,
        { kind: 'stake', tokenIn: 'NEAR' },
        NEAR_ME
      )
    )
    expect(said).toMatch(/0\.1 NEAR/)
    expect(said).toMatch(/ Nothing was signed or sent\.$/)
  })

  it('goes ahead with enough for both steps', async () => {
    await expect(
      assertFollowOnCanRun(
        holding('0.5') as unknown as typeof nearModule,
        { kind: 'stake', tokenIn: 'NEAR' },
        NEAR_ME
      )
    ).resolves.toBeUndefined()
  })

  it('leaves a step that spends a token alone', async () => {
    await expect(
      assertFollowOnCanRun(
        holding('0') as unknown as typeof nearModule,
        { kind: 'supply', tokenIn: 'USDC' },
        NEAR_ME
      )
    ).resolves.toBeUndefined()
  })
})
