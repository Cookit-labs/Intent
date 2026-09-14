import { xdr } from '@stellar/stellar-sdk'

/**
 * How much a settled swap actually delivered.
 *
 * The reason this exists rather than an estimate: a sequence signs its second
 * step against the output of its first, and that output is only knowable once
 * the first has confirmed. A path payment fills against whatever liquidity was
 * there at execution, which is not the figure quoted a moment earlier.
 *
 * Read out of the transaction's own result rather than recomputed from prices.
 * A recomputed figure would be a second estimate wearing a fact's clothes, and
 * supplying it would either leave dust behind or fail for insufficient balance.
 *
 * Returns nothing when the amount cannot be read. That is deliberately not
 * papered over with a fallback: the caller must tell the user to supply
 * manually rather than proceed on a guess.
 *
 * **Decoded XDR exposes plain properties, not accessor methods.** `r.result`
 * rather than `r.result()`, all the way down. Verified against an encoded
 * result rather than inferred from the type definitions, which describe the
 * builder side.
 */

interface DecodedPaymentResult {
  amount?: unknown
}

interface DecodedOperationResult {
  type?: string
  tr?: {
    type?: string
    pathPaymentStrictSendResult?: { type?: string; success?: { last?: DecodedPaymentResult } }
    pathPaymentStrictReceiveResult?: { type?: string; success?: { last?: DecodedPaymentResult } }
  }
}

interface DecodedTransactionResult {
  result?: {
    type?: string
    results?: DecodedOperationResult[]
  }
}

/**
 * The delivered amount from a path payment's result, in base units.
 *
 * Both path payment variants report their outcome the same way: a `last` entry
 * whose `amount` is what reached the destination. A swap routed through several
 * offers produces several claim atoms, and none of them is the delivered
 * figure — reading one would overstate on some routes and understate on others.
 */
export function deliveredFromResultXdr(resultXdr: string): string | undefined {
  if (resultXdr === '') return undefined

  let decoded: DecodedTransactionResult
  try {
    decoded = xdr.TransactionResult.fromXDR(
      resultXdr,
      'base64'
    ) as unknown as DecodedTransactionResult
  } catch {
    return undefined
  }

  const results = decoded.result?.results
  if (!Array.isArray(results)) return undefined

  // Scanned from the end. A plan may hold a trustline before its swap, so the
  // first operation is not reliably the one that delivered anything.
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const amount = deliveredFromOperation(results[i])
    if (amount !== undefined) return amount
  }

  return undefined
}

function deliveredFromOperation(op: DecodedOperationResult | undefined): string | undefined {
  const tr = op?.tr
  if (tr === undefined) return undefined

  const last =
    tr.pathPaymentStrictSendResult?.success?.last ??
    tr.pathPaymentStrictReceiveResult?.success?.last

  const amount = last?.amount
  if (amount === undefined || amount === null) return undefined

  // The amount decodes to a `Hyper`, whose `toString()` gives the integer.
  // `Number()` would lose precision above 2^53, which real stroop amounts
  // reach.
  const text = String(amount)
  return text === '' ? undefined : text
}
