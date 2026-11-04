import { coinWithBalance, Transaction } from '@mysten/sui/transactions'
import { normalizeStructTag } from '@mysten/sui/utils'
import { depositCoinPTB, getPools } from '@naviprotocol/lending'

import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainVenue,
  type PreparedAction,
  type SigningPayload,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient, withTimeout } from './client'
import { naviApy, poolNotes } from './navi-rules'
import { NAVI_POLICY } from './policies'
import { assertPtbSafe } from './safety'
import { SUI_TOKENS } from './tokens'

const REQUEST_TIMEOUT_MS = 10_000
/** How long a pool's rate may be reused. The SDK's default of five minutes is too long to call current. */
const POOL_CACHE_MS = 30_000
/** NAVI reports pool amounts with nine decimals, whatever the token's own. */
const POOL_AMOUNT_SCALE = 1e9

async function prepare(request: ChainActionRequest, account: string): Promise<PreparedAction> {
  assertSuiAccount(account)
  const token = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  if (token?.symbol !== 'USDC') {
    throw new ChainActionRefused(
      `NAVI takes USDC here, not ${request.tokenIn}. Try "supply 10 USDC on NAVI".`
    )
  }
  const amount = toBaseUnits(request.amount, token.decimals)

  const pools = await withTimeout(
    getPools({ env: 'prod', cacheTime: POOL_CACHE_MS }),
    REQUEST_TIMEOUT_MS,
    "Reading NAVI's pools"
  )
  const coinType = normalizeStructTag(token.id)
  const pool = pools.find((p) => normalizeStructTag(p.suiCoinType) === coinType)
  if (pool === undefined || pool.isDeprecated) {
    throw new ChainActionRefused("NAVI's USDC pool isn't open for deposits right now.")
  }
  const room = Number(pool.leftSupply)
  if (Number.isFinite(room) && room < Number(request.amount)) {
    throw new ChainActionRefused(
      `NAVI's USDC pool only has room for about ${Math.floor(room)} more USDC. Try a smaller amount.`
    )
  }

  const tx = new Transaction()
  tx.setSender(account)
  const coin = tx.add(
    coinWithBalance({ type: token.id, balance: BigInt(amount), useGasCoin: false })
  )
  await withTimeout(
    depositCoinPTB(tx, pool, coin, { env: 'prod', amount: Number(amount) }),
    REQUEST_TIMEOUT_MS,
    'Building the deposit'
  )
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)

  const available =
    (Number(pool.totalSupplyAmount) - Number(pool.borrowedAmount)) / POOL_AMOUNT_SCALE
  return {
    venueId: 'navi',
    venueName: 'NAVI',
    kind: 'supply',
    summary: `Supply ${request.amount} USDC to NAVI's main lending market.`,
    pay: { amount: request.amount, symbol: token.symbol },
    apy: naviApy(pool),
    notes: poolNotes({ availableUsdc: available }),
    signing: { family: 'sui', transaction },
  }
}

export const naviVenue: ChainVenue = {
  id: 'navi',
  name: 'NAVI',
  kinds: ['supply'],
  prepare,
  assertSafe: (payload: SigningPayload, account: string) =>
    assertPtbSafe(payload, account, NAVI_POLICY),
}
