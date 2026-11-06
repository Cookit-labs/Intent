import {
  encodeFunctionData,
  formatUnits,
  isAddress,
  parseAbi,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

import { sendRefusal } from '../recipient'
import {
  ChainActionRefused,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
} from '../types'
import {
  approvalNote,
  buildEvmCall,
  evmCallVenueParts,
  type ApprovalSeen,
  type DecodedCall,
  type EvmCallPolicy,
  type EvmReaderClient,
} from './call'
import { evmReader, type EvmClient } from './client'
import { sameAddress } from './submit'
import { AVALANCHE_TOKENS } from './tokens'

// https://github.com/bulla-network/bulla-contracts-V2/blob/main/deployments/avalanche-latest.json.
// Each has code on Avalanche, verified source on Routescan, and no proxy, checked by RPC.
export const BULLA_CLAIM = '0xf28C50EB5996508B558F0FFdDe637C4385117430'
export const BULLA_INVOICE = '0xd60F8Fc651BdcEe2C6Ed9914d610c0E22cE190d6'
// The same file's adminAddress. `owner()` on both contracts returns it, and it has no code.
export const BULLA_OWNER = '0x81f1e947811496453dBBaeA0AC2c250e056BBd96'

const VENUE_NAME = 'Bulla'
const UINT40_MAX = BigInt('1099511627775')
const UINT128_MAX = BigInt('340282366920938463463374607431768211455')
const ZERO = BigInt(0)

const LOCK_NO_NEW_CLAIMS = 1
const LOCK_LOCKED = 2

/** Fixed, so a bill carries no text the person didn't see. */
export const BULLA_DESCRIPTION = 'Invoice created with Intent'

/**
 * BullaInvoice.createInvoice needs an earlier `approveCreateClaim` from the person, which the
 * approval step here can't carry, so a bill is a plain claim made directly on BullaClaimV2.
 */
export const BULLA_CREATE_ABI = parseAbi([
  'struct CreateClaimParams { address creditor; address debtor; uint256 claimAmount; string description; address token; uint8 binding; uint256 dueBy; uint256 impairmentGracePeriod; }',
  'function createClaim(CreateClaimParams params) payable returns (uint256)',
])

export const BULLA_PAY_ABI = parseAbi([
  'function payClaim(uint256 claimId, uint256 amount) payable',
])

export const BULLA_INVOICE_PAY_ABI = parseAbi([
  'function payInvoice(uint256 claimId, uint256 paymentAmount) payable',
])

export const BULLA_READ_ABI = parseAbi([
  'struct Claim { uint256 claimAmount; uint256 paidAmount; uint256 dueBy; uint256 impairmentGracePeriod; address originalCreditor; address debtor; address creditor; address token; address controller; uint8 status; uint8 binding; }',
  'struct PaidClaimCallback { address callbackContract; bytes4 callbackSelector; }',
  'struct PurchaseOrderState { uint256 deliveryDate; uint256 depositAmount; bool isDelivered; }',
  'struct InterestConfig { uint16 interestRateBps; uint16 numberOfPeriodsPerYear; }',
  'struct InterestComputationState { uint256 accruedInterest; uint256 latestPeriodNumber; uint16 protocolFeeBps; uint256 totalGrossInterestPaid; }',
  'struct Invoice { uint256 claimAmount; uint256 paidAmount; uint256 dueBy; address creditor; address debtor; address token; uint8 status; uint8 binding; PurchaseOrderState purchaseOrder; InterestConfig lateFeeConfig; InterestComputationState interestComputationState; }',
  'function lockState() view returns (uint8)',
  'function currentClaimId() view returns (uint256)',
  'function CORE_PROTOCOL_FEE() view returns (uint256)',
  'function owner() view returns (address)',
  'function _bullaClaim() view returns (address)',
  'function protocolFeeBPS() view returns (uint16)',
  'function getClaim(uint256 claimId) view returns (Claim)',
  'function getPaidClaimCallback(uint256 claimId) view returns (PaidClaimCallback)',
  'function getInvoice(uint256 claimId) view returns (Invoice)',
])

/** A claim in the native coin pays by value, which an ERC-20 claim would silently keep. */
const TAKES = AVALANCHE_TOKENS.filter((token) => ['USDC', 'USDT'].includes(token.symbol))

const OWNER_NOTE =
  'One wallet, not a multisig contract, owns Bulla’s contracts here. It can lock them, which stops new invoices and payments, and it can set the fee. The contracts themselves can’t be upgraded.'

// audits/report-2025-09-04.pdf names LPHAC. audits/AUDIT_CHANGELOG_POST_V2.md lists the later versions.
const AUDIT_NOTE =
  'LPHAC audited Bulla’s contracts in its report of Sept 4, 2025. Bulla’s own changelog lists v2.2 and v2.4 as added after that audit, and v2.4 changed the code that runs when an invoice is paid.'

const STATUS_REFUSALS: Record<number, string> = {
  2: 'has already been paid',
  3: 'was rejected by the one billed',
  4: 'was cancelled by the one who sent it',
  5: 'was marked impaired by the one who sent it',
}

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

async function reading<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof ChainActionRefused) throw error
    return refuse(`I couldn't read ${VENUE_NAME} on Avalanche just now, so I can't confirm this.`)
  }
}

interface BillArgs {
  creditor: string
  debtor: string
  claimAmount: bigint
  description: string
  token: string
  binding: number
  dueBy: bigint
  impairmentGracePeriod: bigint
}

/**
 * The due date is left to the chain here, which reverts a past one: this also runs on a sent
 * transaction, which may have been signed just before its date passed.
 */
function checkBill(args: BillArgs, account: string, approval: ApprovalSeen | undefined): void {
  if (approval !== undefined) refuse('A bill moves nothing, so it takes no approval.')
  if (!sameAddress(args.creditor, account)) refuse('This bill does not name you as the one owed.')
  if (sameAddress(args.debtor, account) || sameAddress(args.debtor, zeroAddress)) {
    refuse('This bills an address it should not.')
  }
  if (!TAKES.some((token) => sameAddress(token.id, args.token))) {
    refuse(`This bills in a token I haven't confirmed for ${VENUE_NAME}.`)
  }
  const plainTerms =
    args.binding === 0 &&
    args.impairmentGracePeriod === ZERO &&
    args.description === BULLA_DESCRIPTION &&
    args.dueBy > ZERO &&
    args.dueBy <= UINT40_MAX &&
    args.claimAmount > ZERO &&
    args.claimAmount <= UINT128_MAX
  if (!plainTerms) refuse('This invoice has terms this app does not offer.')
}

function checkPayment(
  call: DecodedCall,
  approval: ApprovalSeen | undefined,
  contract: string
): void {
  const units = call.args[1] as bigint
  if (units <= ZERO) refuse('This pays nothing.')
  if (approval === undefined) return
  if (!sameAddress(approval.spender, contract) || approval.units !== units) {
    refuse('This approval does not match the payment exactly.')
  }
}

const POLICY: EvmCallPolicy = {
  venueName: VENUE_NAME,
  chain: 'avalanche',
  contracts: {
    [BULLA_CLAIM]: {
      abi: [...BULLA_CREATE_ABI, ...BULLA_PAY_ABI] as Abi,
      functions: ['createClaim', 'payClaim'],
      check: (call, { account, approval }) => {
        if (call.functionName === 'createClaim') {
          checkBill(call.args[0] as BillArgs, account, approval)
          return
        }
        checkPayment(call, approval, BULLA_CLAIM)
      },
    },
    [BULLA_INVOICE]: {
      abi: BULLA_INVOICE_PAY_ABI as Abi,
      functions: ['payInvoice'],
      check: (call, { approval }) => checkPayment(call, approval, BULLA_INVOICE),
    },
  },
  spenders: [BULLA_CLAIM, BULLA_INVOICE],
  approvable: TAKES.map((token) => token.id),
}

function takenToken(symbol: string): ChainToken {
  return (
    tokenBySymbol(TAKES, symbol) ??
    refuse(
      `${VENUE_NAME} takes ${TAKES.map((token) => token.symbol).join(' or ')} here, not ${symbol}.`
    )
  )
}

/** The end of that day in UTC, so a bill due today is still good for the rest of today. */
function dueByFrom(dueDate: string | undefined): bigint {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate?.trim() ?? '')
  const notADate = "That isn't a real due date. Use YYYY-MM-DD."
  if (parts === null) return refuse(notADate)
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59))
  if (
    end.getUTCFullYear() !== year ||
    end.getUTCMonth() !== month - 1 ||
    end.getUTCDate() !== day
  ) {
    return refuse(notADate)
  }
  if (end.getTime() <= Date.now()) {
    return refuse(`${parts[0]} has already passed. A due date must be today or later.`)
  }
  return BigInt(end.getTime() / 1000)
}

async function prepareBill(
  request: ChainActionRequest,
  account: string,
  reader: EvmReaderClient
): Promise<PreparedAction> {
  const token = takenToken(request.tokenIn)
  const { recipient } = request
  if (recipient === undefined) return refuse('An invoice needs an address to bill.')
  const badRecipient = sendRefusal('avalanche', token.symbol, recipient, account)
  if (badRecipient !== undefined) throw new ChainActionRefused(badRecipient)
  const dueBy = dueByFrom(request.dueDate)
  const claimAmount = BigInt(toBaseUnits(request.amount, token.decimals))

  const [lock, fee] = await reading(() =>
    Promise.all([
      reader.readContract({ address: BULLA_CLAIM, abi: BULLA_READ_ABI, functionName: 'lockState' }),
      reader.readContract({
        address: BULLA_CLAIM,
        abi: BULLA_READ_ABI,
        functionName: 'CORE_PROTOCOL_FEE',
      }),
    ])
  )
  if (lock === LOCK_NO_NEW_CLAIMS || lock === LOCK_LOCKED) {
    return refuse(`${VENUE_NAME} is locked for new invoices right now.`)
  }
  if (lock !== 0) return refuse(`${VENUE_NAME} is in a state I can't confirm.`)
  if (fee !== ZERO) {
    return refuse(
      `${VENUE_NAME} now charges ${formatUnits(fee, 18)} AVAX to create an invoice, so this would move more than gas from your wallet. This app doesn't pay that fee yet.`
    )
  }

  const data = encodeFunctionData({
    abi: BULLA_CREATE_ABI,
    functionName: 'createClaim',
    args: [
      {
        creditor: account as Address,
        debtor: recipient as Address,
        claimAmount,
        description: BULLA_DESCRIPTION,
        token: token.id as Address,
        binding: 0,
        dueBy,
        impairmentGracePeriod: ZERO,
      },
    ],
  })
  const { signing } = await reading(() =>
    buildEvmCall({ chain: 'avalanche', account, to: BULLA_CLAIM, data }, reader)
  )
  return {
    venueId: 'bulla',
    venueName: VENUE_NAME,
    kind: 'invoice',
    summary: `Bill ${recipient} ${request.amount} ${token.symbol} on ${VENUE_NAME}, due ${request.dueDate}.`,
    pay: { amount: request.amount, symbol: token.symbol },
    notes: [
      'This creates an invoice anyone can read on chain. It moves nothing from your wallet except the network fee.',
      `Nothing forces ${recipient} to pay. They can reject it or ignore it. You can cancel it on ${VENUE_NAME}’s contract while it is unpaid, but this app can’t do that for you yet.`,
      'You hold the invoice as an NFT, and whoever holds it is the one paid. The person you bill needs its number to pay, which the transaction shows on the explorer.',
      `${OWNER_NOTE} ${VENUE_NAME}’s fee to create an invoice is 0 today.`,
      AUDIT_NOTE,
    ],
    signing,
  }
}

/** What is owed beyond the claim itself, read from BullaInvoice for an invoice it controls. */
interface LateFees {
  accrued: bigint
  notes: string[]
}

async function readLateFees(
  id: bigint,
  token: ChainToken,
  reader: EvmReaderClient
): Promise<LateFees> {
  const invoice = await reading(() =>
    reader.readContract({
      address: BULLA_INVOICE,
      abi: BULLA_READ_ABI,
      functionName: 'getInvoice',
      args: [id],
    })
  )
  if (invoice.purchaseOrder.deliveryDate !== ZERO) {
    return refuse(`Invoice ${id} is a purchase order, which this app can't pay yet.`)
  }
  const { interestRateBps } = invoice.lateFeeConfig
  const { accruedInterest, protocolFeeBps } = invoice.interestComputationState
  const notes: string[] = []
  if (interestRateBps > 0) {
    notes.push(
      `${formatUnits(accruedInterest, token.decimals)} ${token.symbol} of this is late-fee interest, at ${interestRateBps / 100}% a year. If more accrues before this lands, a small balance stays owed.`
    )
    if (protocolFeeBps > 0) {
      notes.push(
        `${VENUE_NAME}’s fee adds ${protocolFeeBps / 100}% a year to that rate, and that part goes to ${VENUE_NAME}.`
      )
    }
  }
  return { accrued: accruedInterest, notes }
}

async function preparePayment(
  request: ChainActionRequest,
  account: string,
  reader: EvmReaderClient
): Promise<PreparedAction> {
  const token = takenToken(request.tokenIn)
  const idText = request.invoiceId?.trim() ?? ''
  if (!/^\d{1,78}$/.test(idText)) return refuse('That is not an invoice number.')
  const id = BigInt(idText)
  const typed = BigInt(toBaseUnits(request.amount, token.decimals))

  const [lock, count] = await reading(() =>
    Promise.all([
      reader.readContract({ address: BULLA_CLAIM, abi: BULLA_READ_ABI, functionName: 'lockState' }),
      reader.readContract({
        address: BULLA_CLAIM,
        abi: BULLA_READ_ABI,
        functionName: 'currentClaimId',
      }),
    ])
  )
  if (lock === LOCK_LOCKED) return refuse(`${VENUE_NAME} is locked right now.`)
  if (lock !== 0 && lock !== LOCK_NO_NEW_CLAIMS) {
    return refuse(`${VENUE_NAME} is in a state I can't confirm.`)
  }
  if (id >= count) return refuse(`There is no invoice ${id} on ${VENUE_NAME} on Avalanche.`)

  const [claim, callback] = await reading(() =>
    Promise.all([
      reader.readContract({
        address: BULLA_CLAIM,
        abi: BULLA_READ_ABI,
        functionName: 'getClaim',
        args: [id],
      }),
      reader.readContract({
        address: BULLA_CLAIM,
        abi: BULLA_READ_ABI,
        functionName: 'getPaidClaimCallback',
        args: [id],
      }),
    ])
  )

  const plain = sameAddress(claim.controller, zeroAddress)
  if (!plain && !sameAddress(claim.controller, BULLA_INVOICE)) {
    return refuse(`Number ${id} on ${VENUE_NAME} isn't an invoice this app can pay.`)
  }
  if (claim.status !== 0 && claim.status !== 1) {
    return refuse(`Invoice ${id} ${STATUS_REFUSALS[claim.status] ?? "can't be paid"}.`)
  }
  if (!sameAddress(claim.debtor, account)) {
    return refuse(`Invoice ${id} is billed to ${claim.debtor}, not this wallet.`)
  }
  if (!sameAddress(claim.token, token.id)) {
    const actual = TAKES.find((listed) => sameAddress(listed.id, claim.token))
    return refuse(
      actual === undefined
        ? `Invoice ${id} is in a different token, not ${token.symbol}.`
        : `Invoice ${id} is in ${actual.symbol}, not ${token.symbol}.`
    )
  }
  // v2.4's callback post-dates the audit and runs inside this payment, on a contract the sender
  // picked from a list Bulla's owner alone keeps.
  if (!sameAddress(callback.callbackContract, zeroAddress)) {
    return refuse(
      `Paying invoice ${id} runs another contract the sender chose, which this app hasn't reviewed.`
    )
  }

  const late: LateFees = plain
    ? { accrued: ZERO, notes: [] }
    : await readLateFees(id, token, reader)
  const owed = claim.claimAmount - claim.paidAmount + late.accrued
  if (owed !== typed) {
    return refuse(
      `Invoice ${id} owes ${formatUnits(owed, token.decimals)} ${token.symbol}, not ${request.amount}.`
    )
  }

  const to = plain ? BULLA_CLAIM : BULLA_INVOICE
  const data: Hex = plain
    ? encodeFunctionData({ abi: BULLA_PAY_ABI, functionName: 'payClaim', args: [id, typed] })
    : encodeFunctionData({
        abi: BULLA_INVOICE_PAY_ABI,
        functionName: 'payInvoice',
        args: [id, typed],
      })
  const { signing, needsApproval } = await reading(() =>
    buildEvmCall(
      {
        chain: 'avalanche',
        account,
        to,
        data,
        pull: { token: token.id, spender: to, units: typed },
      },
      reader
    )
  )
  return {
    venueId: 'bulla',
    venueName: VENUE_NAME,
    kind: 'pay_invoice',
    summary: `Pay invoice ${id}: ${request.amount} ${token.symbol} to ${claim.creditor} on ${VENUE_NAME}.`,
    pay: { amount: request.amount, symbol: token.symbol },
    notes: [
      ...(needsApproval ? [approvalNote(VENUE_NAME, request.amount, token.symbol)] : []),
      `This pays ${claim.creditor}, who holds invoice ${id} now. If they pass it on before this lands, the new holder is paid. A payment can’t be taken back.`,
      ...late.notes,
      OWNER_NOTE,
      AUDIT_NOTE,
    ],
    signing,
  }
}

/** Bills and pays invoices on Avalanche only: Bulla's repo has no Monad deployment. */
export function createBullaVenue(reader?: EvmReaderClient, client?: EvmClient): ChainVenue {
  return {
    id: 'bulla',
    name: VENUE_NAME,
    kinds: ['invoice', 'pay_invoice'],
    prepare: async (request, account) => {
      if (!isAddress(account, { strict: false })) {
        return refuse('That account is not an Avalanche address.')
      }
      const chainReader = reader ?? evmReader('avalanche')
      if (request.kind === 'invoice') return prepareBill(request, account, chainReader)
      if (request.kind === 'pay_invoice') return preparePayment(request, account, chainReader)
      return refuse(`${VENUE_NAME} can't ${request.kind} here.`)
    },
    ...evmCallVenueParts(POLICY, client),
  }
}
