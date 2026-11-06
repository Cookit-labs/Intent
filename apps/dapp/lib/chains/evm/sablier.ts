import {
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  isAddress,
  maxUint128,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

import { isValidRecipient } from '../recipient'
import {
  ChainActionRefused,
  toBaseUnits,
  tokenBySymbol,
  type ChainActionRequest,
  type ChainToken,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
  type VenuePosition,
} from '../types'
import {
  approvalNote,
  assertEvmCallSafe,
  buildEvmCall,
  evmCallVenueParts,
  type CheckContext,
  type DecodedCall,
  type EvmCallPolicy,
  type EvmReaderClient,
} from './call'
import { evmReader, type EvmClient } from './client'
import { sameAddress } from './submit'
import { EVM_CHAINS, type EvmChain } from './tokens'

/**
 * Fixed payment streams on Sablier Lockup: the whole amount is funded when the stream is created and
 * unlocks evenly, second by second, over the days the person typed.
 */

// SablierLockup v4.0, immutable. https://docs.sablier.com/guides/lockup/deployments and the `sablier`
// npm package's evm/releases/lockup/v4.0/deployments. Code confirmed by eth_getCode, name() and the
// createWithDurationsLL selector in the runtime, on both chains: see sablier.live.test.ts.
export const SABLIER_LOCKUP: Record<EvmChain, string> = {
  avalanche: '0xB891b41533776Ec20f7738c647a11506AA44b8A8',
  monad: '0x82723C1ffEc9D43dE5FA80b25Da8df99AfD470ba',
}

// SablierComptroller, read only, for the withdrawal fee. The `sablier` npm package's
// evm/comptroller/deployments, and what Lockup's own comptroller() returns on both chains.
export const SABLIER_COMPTROLLER = '0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399'

// The ERC-20s in tokens.ts. The native coin can't be streamed: Lockup only takes ERC-20s.
export const SABLIER_STREAMABLE: Record<EvmChain, readonly string[]> = {
  avalanche: ['USDC', 'USDT'],
  monad: ['USDC', 'USDT0'],
}

// From @sablier/lockup 4.0.1's artifacts. v3.0 removed the broker, so no one else can be paid here.
export const SABLIER_LOCKUP_ABI = [
  {
    type: 'function',
    name: 'createWithDurationsLL',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'sender', type: 'address' },
          { name: 'recipient', type: 'address' },
          { name: 'depositAmount', type: 'uint128' },
          { name: 'token', type: 'address' },
          { name: 'cancelable', type: 'bool' },
          { name: 'transferable', type: 'bool' },
          { name: 'shape', type: 'string' },
        ],
      },
      {
        name: 'unlockAmounts',
        type: 'tuple',
        components: [
          { name: 'start', type: 'uint128' },
          { name: 'cliff', type: 'uint128' },
        ],
      },
      { name: 'granularity', type: 'uint40' },
      {
        name: 'durations',
        type: 'tuple',
        components: [
          { name: 'cliff', type: 'uint40' },
          { name: 'total', type: 'uint40' },
        ],
      },
    ],
    outputs: [{ name: 'streamId', type: 'uint256' }],
  },
  // Only the stream's sender may call it. It refunds the sender in the same transaction, leaves the
  // recipient's part in the contract to withdraw, and has no fee check: only `_withdraw` asks the
  // comptroller. evm-monorepo lockup/src/SablierLockup.sol, tried on both chains in the live test.
  {
    type: 'function',
    name: 'cancel',
    stateMutability: 'payable',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [{ name: 'refundedAmount', type: 'uint128' }],
  },
] as const satisfies Abi

const STREAM_READS = parseAbi([
  'function nextStreamId() view returns (uint256)',
  'function getSender(uint256 streamId) view returns (address)',
  'function statusOf(uint256 streamId) view returns (uint8)',
  'function isCancelable(uint256 streamId) view returns (bool)',
  'function refundableAmountOf(uint256 streamId) view returns (uint128)',
  'function withdrawableAmountOf(uint256 streamId) view returns (uint128)',
  'function getUnderlyingToken(uint256 streamId) view returns (address)',
  'function getRecipient(uint256 streamId) view returns (address)',
])

/** `Lockup.Status`, in order: PENDING, STREAMING, SETTLED, CANCELED, DEPLETED. */
const STATUS_SETTLED = 2
const STATUS_CANCELED = 3
const STATUS_DEPLETED = 4

/** Senders can't be looked up on chain, so every stream is read. Past this, it throws instead. */
const MAX_STREAMS_READ = BigInt(5_000)
const STREAMS_PER_CALL = 500
const STREAM_ID = /^[1-9]\d{0,29}$/

const FEE_READS = parseAbi([
  'function comptroller() view returns (address)',
  'function calculateMinFeeWeiFor(uint8 protocol, address user) view returns (uint256)',
  'function getMinFeeUSDFor(uint8 protocol, address user) view returns (uint256)',
  'function MAX_FEE_USD() view returns (uint256)',
])

/** `ISablierComptroller.Protocol.Lockup`, in @sablier/evm-utils. */
const LOCKUP_PROTOCOL = 2

const DAY_SECONDS = 86_400
const MAX_DAYS = 99_999
const SHAPE = 'linear'
/** Seconds between unlocks. */
const GRANULARITY = 1
const SABLIER_APP = 'https://app.sablier.com'

/** The route's own limit on what can be typed. */
const WHOLE_DAYS = /^[1-9]\d{0,4}$/

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

interface Stream {
  sender: string
  recipient: string
  depositAmount: bigint
  token: string
  cancelable: boolean
  transferable: boolean
  shape: string
  start: bigint
  cliffUnlock: bigint
  granularity: number
  cliff: number
  total: number
}

function streamOf(args: readonly unknown[]): Stream {
  const [params, unlocks, granularity, durations] = args as [
    {
      sender: string
      recipient: string
      depositAmount: bigint
      token: string
      cancelable: boolean
      transferable: boolean
      shape: string
    },
    { start: bigint; cliff: bigint },
    number,
    { cliff: number; total: number },
  ]
  return {
    ...params,
    start: unlocks.start,
    cliffUnlock: unlocks.cliff,
    granularity,
    cliff: durations.cliff,
    total: durations.total,
  }
}

function streamableTokens(chain: EvmChain): ChainToken[] {
  return EVM_CHAINS[chain].tokens.filter((token) =>
    SABLIER_STREAMABLE[chain].includes(token.symbol)
  )
}

function isSablierContract(chain: EvmChain, address: string): boolean {
  return sameAddress(address, SABLIER_LOCKUP[chain]) || sameAddress(address, SABLIER_COMPTROLLER)
}

function checkStream(chain: EvmChain) {
  return (call: DecodedCall, { account, approval }: CheckContext): void => {
    // A cancel names no address. The contract lets only the sender call it, and pays only the sender.
    if (call.functionName === 'cancel') {
      const [streamId] = call.args as readonly [bigint]
      if (streamId === BigInt(0)) refuse('This cancels no stream.')
      if (approval !== undefined) refuse('Canceling a stream needs no approval.')
      return
    }
    const stream = streamOf(call.args)
    if (!sameAddress(stream.sender, account)) {
      refuse('This stream is not from your wallet, so someone else could cancel it.')
    }
    if (
      !isValidRecipient(chain, stream.recipient) ||
      sameAddress(stream.recipient, account) ||
      isSablierContract(chain, stream.recipient)
    ) {
      refuse('This stream pays an address that can’t receive it.')
    }
    if (!streamableTokens(chain).some((token) => sameAddress(token.id, stream.token))) {
      refuse('This stream pays a token I haven’t confirmed for Sablier.')
    }
    if (!stream.cancelable || stream.transferable) {
      refuse('This stream must stay cancelable by you and stay with the address you typed.')
    }
    if (
      stream.start !== BigInt(0) ||
      stream.cliffUnlock !== BigInt(0) ||
      stream.cliff !== 0 ||
      stream.granularity !== GRANULARITY ||
      stream.shape !== SHAPE
    ) {
      refuse('This stream doesn’t pay evenly from start to end.')
    }
    if (
      stream.total < DAY_SECONDS ||
      stream.total % DAY_SECONDS !== 0 ||
      stream.total > MAX_DAYS * DAY_SECONDS
    ) {
      refuse('This stream’s length is not a whole number of days.')
    }
    if (approval === undefined) return
    if (!sameAddress(approval.token, stream.token)) {
      refuse('This approves a different token than the stream pays.')
    }
    if (approval.units !== stream.depositAmount) {
      refuse('This approval must be for exactly the amount streamed.')
    }
  }
}

export function sablierPolicy(chain: EvmChain): EvmCallPolicy {
  const lockup = SABLIER_LOCKUP[chain]
  return {
    venueName: 'Sablier',
    chain,
    contracts: {
      [lockup]: {
        abi: SABLIER_LOCKUP_ABI,
        functions: ['createWithDurationsLL', 'cancel'],
        check: checkStream(chain),
      },
    },
    spenders: [lockup],
    approvable: streamableTokens(chain).map((token) => token.id),
  }
}

/**
 * What the policy can't check, since a sent transaction says nothing about the words behind it:
 * that this stream is the one that was typed.
 */
export function assertStreamAsAsked(
  signing: SigningPayload,
  request: ChainActionRequest,
  account: string,
  chain: EvmChain
): void {
  if (signing.family !== 'evm') refuse('That is not a stream on this chain.')
  let stream: Stream
  try {
    const decoded = decodeFunctionData({ abi: SABLIER_LOCKUP_ABI, data: signing.data as Hex })
    stream = streamOf(decoded.args)
  } catch {
    return refuse('That is not a Sablier stream.')
  }
  const token = tokenBySymbol(streamableTokens(chain), request.tokenIn)
  if (token === undefined || !sameAddress(token.id, stream.token)) {
    refuse('This stream pays a different token than you asked for.')
  }
  if (!sameAddress(stream.sender, account)) refuse('This stream is not from your wallet.')
  if (request.recipient === undefined || !sameAddress(stream.recipient, request.recipient)) {
    refuse('This stream doesn’t pay the address you typed.')
  }
  if (BigInt(toBaseUnits(request.amount, token.decimals)) !== stream.depositAmount) {
    refuse('This stream’s amount is not what you asked for.')
  }
  if (stream.total !== Number(request.durationDays) * DAY_SECONDS) {
    refuse('This stream runs for a different number of days than you asked for.')
  }
}

interface WithdrawalFee {
  wei: bigint
  usd: bigint
  maxUsd: bigint
}

/**
 * The fee is the comptroller's to set, so it's read from there, for this sender. A failed read
 * shows no figure. A comptroller that isn't the pinned one refuses, as it hasn't been reviewed.
 */
async function readWithdrawalFee(
  chain: EvmChain,
  account: string,
  reader: EvmReaderClient
): Promise<WithdrawalFee | undefined> {
  let comptroller: string
  try {
    comptroller = await reader.readContract({
      address: SABLIER_LOCKUP[chain] as Address,
      abi: FEE_READS,
      functionName: 'comptroller',
    })
  } catch {
    return undefined
  }
  if (!sameAddress(comptroller, SABLIER_COMPTROLLER)) {
    refuse('Sablier now uses a fee contract I haven’t checked, so this stays blocked until it is.')
  }
  const address = SABLIER_COMPTROLLER as Address
  const args = [LOCKUP_PROTOCOL, account as Address] as const
  try {
    const [wei, usd, maxUsd] = await Promise.all([
      reader.readContract({ address, abi: FEE_READS, functionName: 'calculateMinFeeWeiFor', args }),
      reader.readContract({ address, abi: FEE_READS, functionName: 'getMinFeeUSDFor', args }),
      reader.readContract({ address, abi: FEE_READS, functionName: 'MAX_FEE_USD' }),
    ])
    return { wei, usd, maxUsd }
  } catch {
    return undefined
  }
}

function feeNote(fee: WithdrawalFee | undefined, chain: EvmChain): string {
  const { nativeSymbol } = EVM_CHAINS[chain]
  // The admin was read on both chains as an account with no code. sablier.live.test.ts holds this.
  const change =
    'Withdrawals ask a separate Sablier fee contract first. A single key can upgrade that contract and change the fee with no waiting period, even on a running stream, so a bad upgrade could stall withdrawals until it is fixed. Canceling doesn’t ask it.'
  if (fee === undefined) {
    return `I couldn't read Sablier's withdrawal fee just now, so no figure is shown. ${change}`
  }
  const cap = `The fee is capped at ${formatUnits(fee.maxUsd, 8)} dollars. ${change}`
  if (fee.wei === BigInt(0)) {
    // https://docs.sablier.com/concepts/fees
    return `Sablier's contract asks no withdrawal fee: it reads as zero right now. Sablier's docs say its own site charges 0.99 dollars per withdrawal, in ${nativeSymbol}. ${cap}`
  }
  const coin = Number(Number(formatUnits(fee.wei, 18)).toPrecision(4))
  return `Sablier charges whoever withdraws a fee, now ${coin} ${nativeSymbol} (about ${formatUnits(fee.usd, 8)} dollars) each time. ${cap}`
}

function streamNotes(
  chain: EvmChain,
  recipient: string,
  days: number,
  fee: WithdrawalFee | undefined
): string[] {
  const { nativeSymbol } = EVM_CHAINS[chain]
  return [
    `The full amount leaves your wallet now and sits in Sablier's contract. It unlocks evenly, second by second, for ${days} ${days === 1 ? 'day' : 'days'}, starting when this lands.`,
    `You can cancel until it ends, by asking here to cancel the stream by its number, or at ${SABLIER_APP}. The part not yet streamed comes back to you, and ${recipient} keeps what has already streamed, so they can't count on the rest.`,
    `The money doesn't arrive by itself. ${recipient} has to withdraw what has streamed, at ${SABLIER_APP} or on the same contract, and needs ${nativeSymbol} for gas and the fee.`,
    feeNote(fee, chain),
    `Check that address is a wallet they can sign from. The stream stays with it and can't be moved to another address, and an exchange deposit address may not be able to claim it.`,
    `Sablier takes no fee to create this stream, and it pays no one else: you pay only gas.`,
    `Sablier's stream contract can't be upgraded and was audited by Cantina and CodeHawks, and neither its docs nor DefiLlama's hack list shows an exploit. Its bug bounty ended on May 1, 2026, so there's no paid reward now for reporting a flaw.`,
  ]
}

function asked(request: ChainActionRequest, account: string, chain: EvmChain) {
  if (request.kind !== 'stream') refuse('Sablier only streams here.')
  if (!isAddress(account, { strict: false })) refuse('That isn’t a wallet this can build for.')
  const token = tokenBySymbol(streamableTokens(chain), request.tokenIn)
  if (token === undefined) {
    const names = SABLIER_STREAMABLE[chain].join(' or ')
    return refuse(
      `Sablier streams ${names} on ${EVM_CHAINS[chain].name} here, not ${request.tokenIn}.`
    )
  }
  const { recipient } = request
  if (recipient === undefined) return refuse('A stream needs an address to go to.')
  if (!isValidRecipient(chain, recipient)) {
    refuse(`That is not an address that can receive on ${EVM_CHAINS[chain].name}.`)
  }
  if (sameAddress(recipient, account)) refuse('That address is your own wallet.')
  if (isSablierContract(chain, recipient)) {
    refuse('That address is one of Sablier’s own contracts, and a stream to it would be stuck.')
  }
  const durationDays = request.durationDays ?? ''
  if (!WHOLE_DAYS.test(durationDays)) {
    refuse(`A stream needs a length in whole days, from 1 to ${MAX_DAYS} days.`)
  }
  const units = BigInt(toBaseUnits(request.amount, token.decimals))
  if (units > maxUint128) refuse('That amount is too large for a stream.')
  return { token, recipient, days: Number(durationDays), units }
}

async function prepareStream(
  chain: EvmChain,
  policy: EvmCallPolicy,
  request: ChainActionRequest,
  account: string,
  reader: EvmReaderClient
): Promise<PreparedAction> {
  const { token, recipient, days, units } = asked(request, account, chain)
  const fee = await readWithdrawalFee(chain, account, reader)
  const lockup = SABLIER_LOCKUP[chain]

  const data = encodeFunctionData({
    abi: SABLIER_LOCKUP_ABI,
    functionName: 'createWithDurationsLL',
    args: [
      {
        sender: account as Address,
        recipient: recipient as Address,
        depositAmount: units,
        token: token.id as Address,
        cancelable: true,
        transferable: false,
        shape: SHAPE,
      },
      { start: BigInt(0), cliff: BigInt(0) },
      GRANULARITY,
      { cliff: 0, total: days * DAY_SECONDS },
    ],
  })

  const { signing, needsApproval } = await buildEvmCall(
    {
      chain,
      account,
      to: lockup,
      data,
      pull: { token: token.id, spender: lockup, units },
    },
    reader
  )
  assertEvmCallSafe(signing, account, policy)
  assertStreamAsAsked(signing, request, account, chain)

  const amount = request.amount.trim()
  const notes = streamNotes(chain, recipient, days, fee)
  return {
    venueId: `sablier-${chain}`,
    venueName: 'Sablier',
    kind: 'stream',
    summary: `Streams ${amount} ${token.symbol} to ${recipient} over ${days} ${days === 1 ? 'day' : 'days'}.`,
    pay: { amount, symbol: token.symbol },
    notes: needsApproval ? [approvalNote('Sablier', amount, token.symbol), ...notes] : notes,
    signing,
  }
}

/**
 * A token off this chain's list can't be trusted to name itself, and anyone can start a stream that
 * names another wallet as its sender, so a stream in one proves nothing and is left alone.
 */
function listedToken(chain: EvmChain, address: string): ChainToken | undefined {
  return EVM_CHAINS[chain].tokens.find((token) => sameAddress(token.id, address))
}

function readStream(chain: EvmChain, streamId: bigint, reader: EvmReaderClient) {
  const contract = { address: SABLIER_LOCKUP[chain] as Address, abi: STREAM_READS }
  const args = [streamId] as const
  return reader.multicall({
    allowFailure: false,
    contracts: [
      { ...contract, functionName: 'getSender', args },
      { ...contract, functionName: 'statusOf', args },
      { ...contract, functionName: 'isCancelable', args },
      { ...contract, functionName: 'refundableAmountOf', args },
      { ...contract, functionName: 'withdrawableAmountOf', args },
      { ...contract, functionName: 'getUnderlyingToken', args },
    ],
  })
}

async function prepareCancel(
  chain: EvmChain,
  request: ChainActionRequest,
  account: string,
  reader: EvmReaderClient
): Promise<PreparedAction> {
  if (!isAddress(account, { strict: false })) refuse('That isn’t a wallet this can build for.')
  const typed = request.streamId?.trim() ?? ''
  if (!STREAM_ID.test(typed)) {
    refuse(`"${typed}" isn't a stream number on Sablier. Try "cancel stream 12".`)
  }
  const streamId = BigInt(typed)
  const lockup = SABLIER_LOCKUP[chain]
  const contract = { address: lockup as Address, abi: STREAM_READS }
  const stream = await (async () => {
    const next = await reader.readContract({ ...contract, functionName: 'nextStreamId' })
    return streamId >= next ? undefined : readStream(chain, streamId, reader)
  })().catch(() =>
    refuse(`I couldn't read stream ${typed} from Sablier just now, so this wasn't built.`)
  )
  if (stream === undefined) {
    refuse(`There is no stream ${typed} on Sablier on ${EVM_CHAINS[chain].name}.`)
  }
  const [sender, status, cancelable, refundable, withdrawable, tokenAddress] = stream
  if (!sameAddress(sender, account)) {
    refuse(
      `Stream ${typed} wasn't started by this wallet. Only the wallet that started a stream can cancel it.`
    )
  }
  if (status === STATUS_CANCELED) {
    refuse(`Stream ${typed} was already canceled, and what hadn't streamed has come back to you.`)
  }
  if (status === STATUS_SETTLED || status === STATUS_DEPLETED) {
    refuse(`Stream ${typed} has finished streaming, so there is nothing left to get back.`)
  }
  if (!cancelable) {
    refuse(`Stream ${typed} can't be canceled: it was set up that way, or that right was given up.`)
  }
  if (refundable === BigInt(0)) {
    refuse(`Stream ${typed} has nothing left to get back.`)
  }
  const token = listedToken(chain, tokenAddress)
  if (token === undefined) {
    refuse(
      `Stream ${typed} pays a token I haven't confirmed, so I won't cancel it here. If you started it, you can cancel it at ${SABLIER_APP}.`
    )
  }
  const recipient = await reader
    .readContract({ ...contract, functionName: 'getRecipient', args: [streamId] })
    .catch(() => undefined)

  const { signing } = await buildEvmCall(
    {
      chain,
      account,
      to: lockup,
      data: encodeFunctionData({
        abi: SABLIER_LOCKUP_ABI,
        functionName: 'cancel',
        args: [streamId],
      }),
    },
    reader
  ).catch((error: unknown) => {
    if (!(error instanceof ChainActionRefused)) throw error
    return refuse(
      `This would fail on the chain right now: Sablier wouldn't cancel stream ${typed}. It keeps running as it was. Check you have enough for the network fee, or try again shortly.`
    )
  })

  const back = formatUnits(refundable, token.decimals)
  const theirs = formatUnits(withdrawable, token.decimals)
  const who = recipient ?? 'the person being paid'
  return {
    venueId: `sablier-${chain}`,
    venueName: 'Sablier',
    kind: 'cancel',
    summary: `End stream ${typed} to ${who}, and get back about ${back} ${token.symbol}.`,
    pay: { amount: back, symbol: token.symbol },
    receive: { amount: back, symbol: token.symbol, approximate: true },
    notes: [
      `What hasn't streamed comes back to your wallet in this same transaction, with no second step. It shrinks every second until this lands, so you get a little less than ${back}.`,
      `${who} keeps what has already streamed. About ${theirs} ${token.symbol} is still waiting for them to withdraw from Sablier, and canceling doesn't send it to them.`,
      'Sablier’s contract asks no fee to cancel, only gas. A cancel can’t be undone.',
    ],
    signing,
  }
}

/**
 * What this wallet's streams can still bring back, each with its id. The contract lists streams by
 * recipient, not sender, and Monad's public RPC reads logs only 100 blocks at a time, so this asks
 * every stream who sent it, with no company indexer. A failed read throws: empty says there are none.
 */
async function readStreamPositions(
  chain: EvmChain,
  account: string,
  reader: EvmReaderClient
): Promise<VenuePosition[]> {
  if (!isAddress(account, { strict: false })) refuse('That isn’t a wallet this can read.')
  const contract = { address: SABLIER_LOCKUP[chain] as Address, abi: STREAM_READS }
  const next = await reader.readContract({ ...contract, functionName: 'nextStreamId' })
  if (next > MAX_STREAMS_READ) throw new Error('Too many Sablier streams to read them all.')

  const ids = Array.from({ length: Number(next) - 1 }, (_, index) => BigInt(index + 1))
  const mine: bigint[] = []
  for (let start = 0; start < ids.length; start += STREAMS_PER_CALL) {
    const page = ids.slice(start, start + STREAMS_PER_CALL)
    const senders = await reader.multicall({
      allowFailure: false,
      contracts: page.map((id) => ({
        ...contract,
        functionName: 'getSender' as const,
        args: [id] as const,
      })),
    })
    mine.push(...page.filter((_, index) => sameAddress(senders[index] as string, account)))
  }

  const streams = await Promise.all(mine.map((id) => readStream(chain, id, reader)))
  return mine.flatMap((id, index): VenuePosition[] => {
    const [, , cancelable, refundable, , tokenAddress] = streams[index] as Awaited<
      ReturnType<typeof readStream>
    >
    const token = listedToken(chain, tokenAddress)
    if (!cancelable || refundable === BigInt(0) || token === undefined) return []
    return [
      {
        slot: 'supplied',
        symbol: token.symbol,
        amount: formatUnits(refundable, token.decimals),
        id: id.toString(),
      },
    ]
  })
}

/** `reader` and `client` are for tests. A chain's real ones are made when they are needed. */
export function createSablierVenue(
  chain: EvmChain,
  reader?: EvmReaderClient,
  client?: EvmClient
): ChainVenue {
  const policy = sablierPolicy(chain)
  return {
    id: `sablier-${chain}`,
    name: 'Sablier',
    kinds: ['stream', 'cancel'],
    prepare: (request, account) =>
      request.kind === 'cancel'
        ? prepareCancel(chain, request, account, reader ?? evmReader(chain))
        : prepareStream(chain, policy, request, account, reader ?? evmReader(chain)),
    positions: (account) => readStreamPositions(chain, account, reader ?? evmReader(chain)),
    ...evmCallVenueParts(policy, client),
  }
}

export const sablierAvalancheVenue = createSablierVenue('avalanche')
export const sablierMonadVenue = createSablierVenue('monad')
