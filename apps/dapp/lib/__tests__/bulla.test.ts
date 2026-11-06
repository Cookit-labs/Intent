import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  zeroAddress,
  type Address,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  BULLA_CLAIM,
  BULLA_CREATE_ABI,
  BULLA_DESCRIPTION,
  BULLA_INVOICE,
  BULLA_PAY_ABI,
  BULLA_INVOICE_PAY_ABI,
  createBullaVenue,
} from '../chains/evm/bulla'
import { bullaListing } from '../chains/evm/bulla-listing'
import type { EvmReaderClient } from '../chains/evm/call'
import { AVALANCHE_TOKENS } from '../chains/evm/tokens'
import { ChainActionRefused, type ChainActionRequest, type SigningPayload } from '../chains/types'

const ME = '0x1111111111111111111111111111111111111111'
const CLIENT = '0x2222222222222222222222222222222222222222'
const STRANGER = '0x3333333333333333333333333333333333333333'
const USDC = AVALANCHE_TOKENS.find((t) => t.symbol === 'USDC')?.id as Address
const USDT = AVALANCHE_TOKENS.find((t) => t.symbol === 'USDT')?.id as Address
const AVALANCHE_ID = 43114
const FIVE_HUNDRED = BigInt(500_000_000)

interface ClaimFake {
  claimAmount: bigint
  paidAmount: bigint
  dueBy: bigint
  impairmentGracePeriod: bigint
  originalCreditor: Address
  debtor: Address
  creditor: Address
  token: Address
  controller: Address
  status: number
  binding: number
}

const claimOf = (over: Partial<ClaimFake> = {}): ClaimFake => ({
  claimAmount: FIVE_HUNDRED,
  paidAmount: BigInt(0),
  dueBy: BigInt(4_000_000_000),
  impairmentGracePeriod: BigInt(0),
  originalCreditor: CLIENT,
  debtor: ME,
  creditor: CLIENT,
  token: USDC,
  controller: zeroAddress,
  status: 0,
  binding: 0,
  ...over,
})

interface InvoiceFake {
  deliveryDate?: bigint
  interestRateBps?: number
  accruedInterest?: bigint
  protocolFeeBps?: number
}

interface FakeChain {
  lockState?: number
  fee?: bigint
  count?: bigint
  claim?: ClaimFake
  invoice?: InvoiceFake
  callback?: Address
  allowance?: bigint
  callFails?: boolean
  readFails?: boolean
}

function readerFor(chain: FakeChain = {}) {
  const calls: { to: string; data: string }[] = []
  const claim = chain.claim ?? claimOf()
  const reader = {
    readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
      if (chain.readFails === true) throw new Error('rpc down')
      switch (functionName) {
        case 'lockState':
          return chain.lockState ?? 0
        case 'CORE_PROTOCOL_FEE':
          return chain.fee ?? BigInt(0)
        case 'currentClaimId':
          return chain.count ?? BigInt(100)
        case 'getClaim':
          return claim
        case 'getPaidClaimCallback':
          return {
            callbackContract: chain.callback ?? zeroAddress,
            callbackSelector: chain.callback === undefined ? '0x00000000' : '0x12345678',
          }
        case 'getInvoice':
          return {
            ...claim,
            purchaseOrder: {
              deliveryDate: chain.invoice?.deliveryDate ?? BigInt(0),
              depositAmount: BigInt(0),
              isDelivered: false,
            },
            lateFeeConfig: {
              interestRateBps: chain.invoice?.interestRateBps ?? 0,
              numberOfPeriodsPerYear: 0,
            },
            interestComputationState: {
              accruedInterest: chain.invoice?.accruedInterest ?? BigInt(0),
              latestPeriodNumber: BigInt(0),
              protocolFeeBps: chain.invoice?.protocolFeeBps ?? 0,
              totalGrossInterestPaid: BigInt(0),
            },
          }
        case 'allowance':
          return chain.allowance ?? BigInt(0)
        default:
          throw new Error(`unexpected read ${functionName} on ${address}`)
      }
    },
    call: async (args: { to: string; data: string }) => {
      calls.push({ to: args.to, data: args.data })
      if (chain.callFails === true) throw new Error('reverted')
      return { data: '0x' }
    },
  } as unknown as EvmReaderClient
  return { reader, calls }
}

const bill = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'invoice',
  amount: '500',
  tokenIn: 'USDC',
  recipient: CLIENT,
  dueDate: '2099-12-01',
  ...over,
})

const pay = (over: Partial<ChainActionRequest> = {}): ChainActionRequest => ({
  kind: 'pay_invoice',
  amount: '500',
  tokenIn: 'USDC',
  invoiceId: '12',
  ...over,
})

function evmPayload(signing: SigningPayload) {
  if (signing.family !== 'evm') throw new Error('not evm')
  return signing
}

const refusal = (reason: RegExp) =>
  expect.objectContaining({
    constructor: ChainActionRefused,
    message: expect.stringMatching(reason),
  })

function billingCalldata(over: Record<string, unknown> = {}): string {
  return encodeFunctionData({
    abi: BULLA_CREATE_ABI,
    functionName: 'createClaim',
    args: [
      {
        creditor: ME,
        debtor: CLIENT,
        claimAmount: FIVE_HUNDRED,
        description: BULLA_DESCRIPTION,
        token: USDC,
        binding: 0,
        dueBy: BigInt(4_000_000_000),
        impairmentGracePeriod: BigInt(0),
        ...over,
      },
    ],
  } as never)
}

const payCalldata = (id = BigInt(12), units = FIVE_HUNDRED) =>
  encodeFunctionData({ abi: BULLA_PAY_ABI, functionName: 'payClaim', args: [id, units] })

const approveData = (spender: string, units: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as Address, units] })

const payload = (
  over: Partial<Extract<SigningPayload, { family: 'evm' }>> = {}
): SigningPayload => ({
  family: 'evm',
  chainId: AVALANCHE_ID,
  to: BULLA_CLAIM,
  data: billingCalldata(),
  value: '0',
  ...over,
})

describe('billing with Bulla', () => {
  it('bills the typed address, in the person’s name, with nothing but gas', async () => {
    const { reader } = readerFor()
    const prepared = await createBullaVenue(reader).prepare(bill(), ME)
    const signing = evmPayload(prepared.signing)
    expect(signing.to).toBe(BULLA_CLAIM)
    expect(signing.value).toBe('0')
    expect(signing.approval).toBeUndefined()
    const decoded = decodeFunctionData({
      abi: BULLA_CREATE_ABI,
      data: signing.data as `0x${string}`,
    })
    expect(decoded.functionName).toBe('createClaim')
    expect(decoded.args[0]).toMatchObject({
      creditor: ME,
      debtor: CLIENT,
      claimAmount: FIVE_HUNDRED,
      token: USDC,
      binding: 0,
      description: BULLA_DESCRIPTION,
      impairmentGracePeriod: BigInt(0),
    })
    expect(decoded.args[0].dueBy).toBe(BigInt(Date.UTC(2099, 11, 1, 23, 59, 59) / 1000))
    expect(prepared.kind).toBe('invoice')
    expect(prepared.pay).toEqual({ amount: '500', symbol: 'USDC' })
  })

  it('names the auditor and the owner’s powers on the card', async () => {
    const { reader } = readerFor()
    const { notes } = await createBullaVenue(reader).prepare(bill(), ME)
    const text = notes.join(' ')
    expect(text).toMatch(/LPHAC/)
    expect(text).toMatch(/v2\.2/)
    expect(text).toMatch(/v2\.4/)
    expect(text).toMatch(/lock/i)
    expect(text).toMatch(/fee/i)
    expect(text).toMatch(/reject/i)
  })

  it('tries the call before offering it', async () => {
    const { reader, calls } = readerFor()
    await createBullaVenue(reader).prepare(bill(), ME)
    expect(calls).toHaveLength(1)
    await expect(
      createBullaVenue(readerFor({ callFails: true }).reader).prepare(bill(), ME)
    ).rejects.toThrow(/fail on the chain/)
  })

  it('refuses a due date in the past', async () => {
    const { reader } = readerFor()
    await expect(
      createBullaVenue(reader).prepare(bill({ dueDate: '2020-01-01' }), ME)
    ).rejects.toThrow(/already passed.*Nothing was signed or sent\./)
  })

  it('takes a due date of today', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const prepared = await createBullaVenue(readerFor().reader).prepare(
      bill({ dueDate: today }),
      ME
    )
    expect(prepared.kind).toBe('invoice')
  })

  it.each(['2099-02-30', '2099-13-01', 'next week', '20991201', undefined])(
    'refuses %s as a due date',
    async (dueDate) => {
      await expect(
        createBullaVenue(readerFor().reader).prepare(bill({ dueDate }), ME)
      ).rejects.toThrow(/due date/)
    }
  )

  it('refuses a fee instead of hiding one, and names it', async () => {
    const fee = BigInt('20000000000000000')
    await expect(createBullaVenue(readerFor({ fee }).reader).prepare(bill(), ME)).rejects.toThrow(
      /0\.02 AVAX.*Nothing was signed or sent\./
    )
  })

  it.each([1, 2])('refuses when Bulla is locked (state %i)', async (lockState) => {
    await expect(
      createBullaVenue(readerFor({ lockState }).reader).prepare(bill(), ME)
    ).rejects.toThrow(/locked/)
  })

  it('refuses to bill in AVAX, which this venue does not handle', async () => {
    await expect(
      createBullaVenue(readerFor().reader).prepare(bill({ tokenIn: 'AVAX' }), ME)
    ).rejects.toThrow(/USDC or USDT/)
  })

  it('refuses a listed token that isn’t a stablecoin it bills in', async () => {
    await expect(
      createBullaVenue(readerFor().reader).prepare(bill({ tokenIn: 'WAVAX' }), ME)
    ).rejects.toThrow(/USDC or USDT/)
  })

  it('refuses a token not on the chain’s list', async () => {
    await expect(
      createBullaVenue(readerFor().reader).prepare(bill({ tokenIn: 'SCAM' }), ME)
    ).rejects.toThrow(/USDC or USDT/)
  })

  it('refuses a shortened, zero or missing address, and the person’s own', async () => {
    const venue = createBullaVenue(readerFor().reader)
    await expect(venue.prepare(bill({ recipient: '0xabc' }), ME)).rejects.toThrow(
      ChainActionRefused
    )
    await expect(venue.prepare(bill({ recipient: zeroAddress }), ME)).rejects.toThrow(
      ChainActionRefused
    )
    await expect(venue.prepare(bill({ recipient: undefined }), ME)).rejects.toThrow(
      ChainActionRefused
    )
    await expect(venue.prepare(bill({ recipient: ME }), ME)).rejects.toThrow(ChainActionRefused)
  })

  it('refuses when the chain can’t be read', async () => {
    await expect(
      createBullaVenue(readerFor({ readFails: true }).reader).prepare(bill(), ME)
    ).rejects.toThrow(/couldn't read/)
  })

  it('refuses an account that is not an address', async () => {
    await expect(
      createBullaVenue(readerFor().reader).prepare(bill(), 'alice.near')
    ).rejects.toThrow(/not an Avalanche address/)
  })

  it('refuses a kind it does not do', async () => {
    await expect(
      createBullaVenue(readerFor().reader).prepare(bill({ kind: 'send' }), ME)
    ).rejects.toThrow(ChainActionRefused)
  })
})

describe('paying with Bulla', () => {
  it('pays a plain claim through the claim contract, with an exact approval when needed', async () => {
    const { reader, calls } = readerFor()
    const prepared = await createBullaVenue(reader).prepare(pay(), ME)
    const signing = evmPayload(prepared.signing)
    expect(signing.to).toBe(BULLA_CLAIM)
    expect(signing.value).toBe('0')
    expect(signing.data).toBe(payCalldata())
    expect(signing.approval).toEqual({ to: USDC, data: approveData(BULLA_CLAIM, FIVE_HUNDRED) })
    expect(calls).toHaveLength(0)
    expect(prepared.notes.join(' ')).toMatch(/asks twice/)
    expect(prepared.summary).toContain(CLIENT)
  })

  it('skips the approval and tries the call when the allowance covers it', async () => {
    const { reader, calls } = readerFor({ allowance: FIVE_HUNDRED })
    const signing = evmPayload((await createBullaVenue(reader).prepare(pay(), ME)).signing)
    expect(signing.approval).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('pays an invoice made through BullaInvoice on that contract', async () => {
    const claim = claimOf({ controller: BULLA_INVOICE })
    const { reader } = readerFor({ claim })
    const signing = evmPayload((await createBullaVenue(reader).prepare(pay(), ME)).signing)
    expect(signing.to).toBe(BULLA_INVOICE)
    expect(signing.data).toBe(
      encodeFunctionData({
        abi: BULLA_INVOICE_PAY_ABI,
        functionName: 'payInvoice',
        args: [BigInt(12), FIVE_HUNDRED],
      })
    )
    expect(signing.approval).toEqual({ to: USDC, data: approveData(BULLA_INVOICE, FIVE_HUNDRED) })
  })

  it('counts late-fee interest as owed, and shows the fee Bulla keeps of it', async () => {
    const claim = claimOf({ controller: BULLA_INVOICE })
    const invoice = {
      interestRateBps: 1000,
      accruedInterest: BigInt(10_000_000),
      protocolFeeBps: 500,
    }
    const venue = createBullaVenue(readerFor({ claim, invoice }).reader)
    await expect(venue.prepare(pay(), ME)).rejects.toThrow(/510 USDC/)
    const prepared = await venue.prepare(pay({ amount: '510' }), ME)
    const text = prepared.notes.join(' ')
    expect(text).toMatch(/10 USDC.*late/i)
    expect(text).toMatch(/5%/)
  })

  it('refuses a purchase order', async () => {
    const claim = claimOf({ controller: BULLA_INVOICE })
    await expect(
      createBullaVenue(
        readerFor({ claim, invoice: { deliveryDate: BigInt(4_000_000_000) } }).reader
      ).prepare(pay(), ME)
    ).rejects.toThrow(/purchase order/)
  })

  it('refuses a claim run by any other contract', async () => {
    const claim = claimOf({ controller: STRANGER as Address })
    await expect(createBullaVenue(readerFor({ claim }).reader).prepare(pay(), ME)).rejects.toThrow(
      /isn't an invoice/
    )
  })

  it('refuses an amount that is not exactly what is owed', async () => {
    const venue = createBullaVenue(readerFor().reader)
    await expect(venue.prepare(pay({ amount: '499.99' }), ME)).rejects.toThrow(
      /500 USDC, not 499\.99/
    )
    await expect(venue.prepare(pay({ amount: '500.01' }), ME)).rejects.toThrow(
      /500 USDC, not 500\.01/
    )
  })

  it('counts what has already been paid', async () => {
    const claim = claimOf({ paidAmount: BigInt(200_000_000), status: 1 })
    const venue = createBullaVenue(readerFor({ claim }).reader)
    await expect(venue.prepare(pay(), ME)).rejects.toThrow(/300 USDC/)
    const signing = evmPayload((await venue.prepare(pay({ amount: '300' }), ME)).signing)
    expect(signing.data).toBe(payCalldata(BigInt(12), BigInt(300_000_000)))
  })

  it('refuses the wrong token', async () => {
    const venue = createBullaVenue(readerFor({ claim: claimOf({ token: USDT }) }).reader)
    await expect(venue.prepare(pay(), ME)).rejects.toThrow(/USDT, not USDC/)
  })

  it('refuses a claim in a token this app does not list', async () => {
    const venue = createBullaVenue(
      readerFor({ claim: claimOf({ token: STRANGER as Address }) }).reader
    )
    await expect(venue.prepare(pay(), ME)).rejects.toThrow(/different token/)
  })

  it.each([
    [2, /already been paid/],
    [3, /rejected/],
    [4, /cancelled/],
    [5, /impaired/],
    [9, /can't be paid/],
  ])('refuses status %i', async (status, reason) => {
    const venue = createBullaVenue(readerFor({ claim: claimOf({ status }) }).reader)
    await expect(venue.prepare(pay(), ME)).rejects.toThrow(reason)
  })

  it('refuses an invoice billed to someone else', async () => {
    const venue = createBullaVenue(
      readerFor({ claim: claimOf({ debtor: STRANGER as Address }) }).reader
    )
    await expect(venue.prepare(pay(), ME)).rejects.toThrow(/billed to .*not this wallet/)
  })

  it('refuses an invoice that does not exist', async () => {
    const venue = createBullaVenue(readerFor({ count: BigInt(12) }).reader)
    await expect(venue.prepare(pay(), ME)).rejects.toThrow(/no invoice 12/)
  })

  it.each(['12a', '-1', '', undefined])('refuses %s as an invoice id', async (invoiceId) => {
    const venue = createBullaVenue(readerFor().reader)
    await expect(venue.prepare(pay({ invoiceId }), ME)).rejects.toThrow(/invoice number/)
  })

  it('refuses a claim with a paid callback, which runs code nobody here has reviewed', async () => {
    const venue = createBullaVenue(readerFor({ callback: STRANGER as Address }).reader)
    await expect(venue.prepare(pay(), ME)).rejects.toThrow(/runs another contract/)
  })

  it('refuses when fully locked, but pays when only new claims are stopped', async () => {
    await expect(
      createBullaVenue(readerFor({ lockState: 2 }).reader).prepare(pay(), ME)
    ).rejects.toThrow(/locked/)
    const prepared = await createBullaVenue(readerFor({ lockState: 1 }).reader).prepare(pay(), ME)
    expect(prepared.kind).toBe('pay_invoice')
  })

  it('states who gets paid, and the audit gap', async () => {
    const { notes } = await createBullaVenue(readerFor().reader).prepare(pay(), ME)
    const text = notes.join(' ')
    expect(text).toContain(CLIENT)
    expect(text).toMatch(/LPHAC/)
    expect(text).toMatch(/v2\.4/)
  })
})

describe('assertSafe', () => {
  const venue = createBullaVenue(readerFor().reader)
  const check = (signing: SigningPayload, account = ME) => venue.assertSafe(signing, account)

  it('passes what the venue builds', async () => {
    const built = await venue.prepare(bill(), ME)
    expect(() => venue.assertSafe(built.signing, ME)).not.toThrow()
    const paid = await venue.prepare(pay(), ME)
    expect(() => venue.assertSafe(paid.signing, ME)).not.toThrow()
    const viaInvoice = await createBullaVenue(
      readerFor({ claim: claimOf({ controller: BULLA_INVOICE }) }).reader
    ).prepare(pay(), ME)
    expect(() => venue.assertSafe(viaInvoice.signing, ME)).not.toThrow()
  })

  it('refuses the wrong account', () => {
    expect(() => check(payload(), STRANGER)).toThrow(/you as the one owed/)
  })

  it('refuses credit going to anyone else', () => {
    expect(() => check(payload({ data: billingCalldata({ creditor: STRANGER }) }))).toThrow(
      /you as the one owed/
    )
  })

  it('refuses billing yourself or nobody', () => {
    expect(() => check(payload({ data: billingCalldata({ debtor: ME }) }))).toThrow(/bills/)
    expect(() => check(payload({ data: billingCalldata({ debtor: zeroAddress }) }))).toThrow(
      /bills/
    )
  })

  it('refuses an unknown contract', () => {
    expect(() => check(payload({ to: STRANGER }))).toThrow(/haven't confirmed for Bulla/)
    expect(() => check(payload({ to: USDC }))).toThrow(/haven't confirmed for Bulla/)
  })

  it('refuses the wrong chain and another family', () => {
    expect(() => check(payload({ chainId: 143 }))).toThrow(/not for Avalanche/)
    expect(() => check({ family: 'solana', transaction: 'AA==' })).toThrow(
      /not a Avalanche|not an Avalanche/
    )
  })

  it('refuses an unknown function', () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [STRANGER as Address, FIVE_HUNDRED],
    })
    expect(() => check(payload({ data }))).toThrow(/haven't confirmed for Bulla/)
    expect(() => check(payload({ to: BULLA_INVOICE, data: billingCalldata() }))).toThrow(
      /haven't confirmed for Bulla/
    )
  })

  it('refuses extra calldata', () => {
    expect(() => check(payload({ data: `${billingCalldata()}00` }))).toThrow(/extra data/)
    expect(() => check(payload({ data: `${payCalldata()}deadbeef` }))).toThrow(/extra data/)
  })

  it('refuses any value on either call', () => {
    expect(() => check(payload({ value: '1' }))).toThrow(/spends AVAX/)
    expect(() => check(payload({ data: payCalldata(), value: '1' }))).toThrow(/spends AVAX/)
  })

  it('refuses a token it does not bill in', () => {
    expect(() => check(payload({ data: billingCalldata({ token: STRANGER }) }))).toThrow(/token/)
    expect(() => check(payload({ data: billingCalldata({ token: zeroAddress }) }))).toThrow(/token/)
  })

  it('refuses a bound claim, a late grace period, stray description or no due date', () => {
    expect(() => check(payload({ data: billingCalldata({ binding: 1 }) }))).toThrow(/terms/)
    expect(() =>
      check(payload({ data: billingCalldata({ impairmentGracePeriod: BigInt(1) }) }))
    ).toThrow(/terms/)
    expect(() =>
      check(payload({ data: billingCalldata({ description: 'pay here: evil.example' }) }))
    ).toThrow(/terms/)
    expect(() => check(payload({ data: billingCalldata({ dueBy: BigInt(0) }) }))).toThrow(/terms/)
    expect(() => check(payload({ data: billingCalldata({ claimAmount: BigInt(0) }) }))).toThrow(
      /terms/
    )
    expect(() => check(payload({ data: billingCalldata({ claimAmount: maxUint256 }) }))).toThrow(
      /terms/
    )
  })

  it('refuses any approval alongside a bill, which moves nothing', () => {
    expect(() =>
      check(payload({ approval: { to: USDC, data: approveData(BULLA_CLAIM, FIVE_HUNDRED) } }))
    ).toThrow(/moves nothing/)
  })

  it('refuses an unlimited approval', () => {
    expect(() =>
      check(
        payload({
          data: payCalldata(),
          approval: { to: USDC, data: approveData(BULLA_CLAIM, maxUint256) },
        })
      )
    ).toThrow(/unlimited/)
  })

  it('refuses an approval for the wrong amount', () => {
    expect(() =>
      check(
        payload({
          data: payCalldata(),
          approval: { to: USDC, data: approveData(BULLA_CLAIM, FIVE_HUNDRED + BigInt(1)) },
        })
      )
    ).toThrow(/exactly/)
  })

  it('refuses an approval to someone else, or to the other Bulla contract', () => {
    expect(() =>
      check(
        payload({
          data: payCalldata(),
          approval: { to: USDC, data: approveData(STRANGER, FIVE_HUNDRED) },
        })
      )
    ).toThrow(/isn't confirmed for Bulla/)
    expect(() =>
      check(
        payload({
          data: payCalldata(),
          approval: { to: USDC, data: approveData(BULLA_INVOICE, FIVE_HUNDRED) },
        })
      )
    ).toThrow(/exactly/)
  })

  it('refuses approving a token it does not take', () => {
    expect(() =>
      check(
        payload({
          data: payCalldata(),
          approval: { to: STRANGER, data: approveData(BULLA_CLAIM, FIVE_HUNDRED) },
        })
      )
    ).toThrow(/approve a token/)
  })

  it('refuses a payment of nothing', () => {
    expect(() => check(payload({ data: payCalldata(BigInt(12), BigInt(0)) }))).toThrow(/nothing/)
  })
})

describe('venue shape', () => {
  it('does only the two invoice kinds, and is never raced', () => {
    const venue = createBullaVenue(readerFor().reader)
    expect(venue.id).toBe('bulla')
    expect(venue.kinds).toEqual(['invoice', 'pay_invoice'])
    expect(venue.quote).toBeUndefined()
    expect(venue.submit).toBeTypeOf('function')
  })

  it('lists as executing on Avalanche', () => {
    expect(bullaListing).toMatchObject({
      id: 'bulla',
      family: 'evm',
      chains: ['Avalanche'],
      integration: 'executes',
    })
  })
})

it('is a refusal type, not a bare error', async () => {
  await expect(
    createBullaVenue(readerFor({ lockState: 2 }).reader).prepare(pay(), ME)
  ).rejects.toEqual(refusal(/locked/))
})
