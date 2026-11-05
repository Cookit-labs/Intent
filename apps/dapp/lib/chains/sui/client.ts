import { SuiGrpcClient } from '@mysten/sui/grpc'
import type { Transaction } from '@mysten/sui/transactions'
import { isValidSuiAddress, toBase64 } from '@mysten/sui/utils'

import { ChainActionRefused } from '../types'

/** Foundation fullnodes have JSON-RPC turned off, so everything here is gRPC. */
const DEFAULT_GRPC_URL = 'https://fullnode.mainnet.sui.io:443'

let cached: { url: string; client: SuiGrpcClient } | undefined

export function suiClient(env: Record<string, string | undefined> = process.env): SuiGrpcClient {
  const url = env['SUI_GRPC_URL']?.trim() || DEFAULT_GRPC_URL
  if (cached?.url !== url) {
    cached = { url, client: new SuiGrpcClient({ network: 'mainnet', baseUrl: url }) }
  }
  return cached.client
}

/** The SDKs accept no deadline of their own for most calls, so one is put around them. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

export function assertSuiAccount(account: string): void {
  if (!isValidSuiAddress(account)) {
    throw new ChainActionRefused('That is not a Sui address. Connect a Sui wallet and try again.')
  }
}

/**
 * A refusal for a build failure the user can act on. Building resolves real coins and
 * dry-runs the transaction, so a failure here usually says something true about the
 * wallet. Anything else is left for the route to report as an outage.
 */
export function refusalFromBuildError(e: unknown, symbol: string): ChainActionRefused | undefined {
  const message = e instanceof Error ? e.message : String(e)
  if (/insufficient ?(coin ?)?balance/i.test(message) && !/\bgas\b/i.test(message)) {
    return new ChainActionRefused(
      `You don't have enough ${symbol} in this wallet for that. Check your balance and try a smaller amount.`
    )
  }
  if (/gas/i.test(message) && /(no valid|insufficient|not enough|balance)/i.test(message)) {
    return new ChainActionRefused(
      'This wallet needs a little SUI to pay the network fee. Add some SUI and try again.'
    )
  }
  if (/resolution failed|moveabort|dry.?run|simulat|execution/i.test(message)) {
    return new ChainActionRefused(
      'This transaction would fail if sent right now, so I stopped before asking you to sign. Try again shortly or try a different amount.'
    )
  }
  return undefined
}

const BUILD_TIMEOUT_MS = 20_000

/** Resolves coins, sets gas and dry-runs on gRPC, then returns base64 bytes. Nothing is signed. */
export async function buildUnsigned(
  tx: Transaction,
  client: SuiGrpcClient,
  symbol: string
): Promise<string> {
  try {
    return toBase64(await withTimeout(tx.build({ client }), BUILD_TIMEOUT_MS, 'Building'))
  } catch (e) {
    throw refusalFromBuildError(e, symbol) ?? e
  }
}
