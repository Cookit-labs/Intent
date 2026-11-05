import { createHash, createPublicKey, verify } from 'node:crypto'

/**
 * Checks that a 1Click quote was signed by 1Click, without its SDK. This is the
 * same field list, hash and key as `verifyQuoteSignature` in
 * `@defuse-protocol/one-click-sdk-typescript` 0.1.26.
 *
 * It catches a quote altered on the way here, including its deposit address. It
 * cannot catch 1Click itself signing something wrong.
 */
const MANAGER_PUBLIC_KEY = 'reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc'
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex') || '0'}`)
  let text = ''
  while (value > BigInt(0)) {
    text = `${BASE58[Number(value % BigInt(58))]}${text}`
    value /= BigInt(58)
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    text = `1${text}`
  }
  return text
}

function base58Decode(text: string): Buffer {
  let value = BigInt(0)
  for (const char of text) {
    const digit = BASE58.indexOf(char)
    if (digit < 0) throw new Error('not base58')
    value = value * BigInt(58) + BigInt(digit)
  }
  let hex = value === BigInt(0) ? '' : value.toString(16)
  if (hex.length % 2 === 1) hex = `0${hex}`
  let zeros = 0
  for (const char of text) {
    if (char !== '1') break
    zeros += 1
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')])
}

/** Sorted keys, undefined dropped: what `json-stable-stringify` produces for these values. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const parts = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value)
}

export interface SignedQuoteFields {
  quote: Record<string, unknown>
  quoteRequest: Record<string, unknown>
  signature: string
  timestamp: string
}

function orUndefined(value: unknown): unknown {
  return value === '' || value === 0 || value === null || value === false ? undefined : value
}

function signedMessage({ quote, quoteRequest: request, timestamp }: SignedQuoteFields): string {
  const signedRequest = {
    dry: request['dry'],
    swapType: request['swapType'],
    slippageTolerance: request['slippageTolerance'],
    originAsset: request['originAsset'],
    depositType: request['depositType'],
    destinationAsset: request['destinationAsset'],
    amount: request['amount'],
    refundTo: request['refundTo'],
    refundType: request['refundType'],
    recipient: request['recipient'],
    recipientType: request['recipientType'],
    deadline: request['deadline'],
    quoteWaitingTimeMs: orUndefined(request['quoteWaitingTimeMs']),
    referral: orUndefined(request['referral']),
    virtualChainRecipient: orUndefined(request['virtualChainRecipient']),
    virtualChainRefundRecipient: orUndefined(request['virtualChainRefundRecipient']),
    customRecipientMsg: orUndefined(request['customRecipientMsg']),
  }
  const amounts = {
    amountIn: quote['amountIn'],
    amountInFormatted: quote['amountInFormatted'],
    amountInUsd: quote['amountInUsd'],
    minAmountIn: quote['minAmountIn'],
    amountOut: quote['amountOut'],
    amountOutFormatted: quote['amountOutFormatted'],
    amountOutUsd: quote['amountOutUsd'],
    minAmountOut: quote['minAmountOut'],
  }
  const signedQuote =
    request['dry'] === true
      ? amounts
      : {
          ...amounts,
          depositAddress: orUndefined(quote['depositAddress']),
          depositMemo: orUndefined(quote['depositMemo']),
          deadline: orUndefined(quote['deadline']),
          timeWhenInactive: orUndefined(quote['timeWhenInactive']),
          timeEstimate: orUndefined(quote['timeEstimate']),
          refundFee: orUndefined(quote['refundFee']),
          withdrawFee: orUndefined(quote['withdrawFee']),
        }
  const text = stableStringify({ ...signedRequest, ...signedQuote, timestamp })
  return base58Encode(createHash('sha256').update(text).digest())
}

export function verifyQuoteSignature(
  response: SignedQuoteFields,
  publicKey: string = MANAGER_PUBLIC_KEY
): boolean {
  try {
    const signature = base58Decode(response.signature.replace(/^ed25519:/, ''))
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, base58Decode(publicKey)]),
      format: 'der',
      type: 'spki',
    })
    return verify(null, Buffer.from(signedMessage(response)), key, signature)
  } catch {
    return false
  }
}
