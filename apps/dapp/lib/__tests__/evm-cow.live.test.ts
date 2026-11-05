import { createPublicClient, hashDomain, http, parseAbi, type Address } from 'viem'
import { avalanche } from 'viem/chains'
import { beforeEach, describe, expect, it } from 'vitest'

import { cowBook, cowVenue } from '../chains/evm/cow'
import {
  COW_APP_DATA,
  COW_APP_DATA_HASH,
  COW_BUY_NATIVE,
  COW_DOMAIN,
  COW_SETTLEMENT,
  COW_VAULT_RELAYER,
  cowOrderUid,
  WAVAX,
  type CowOrder,
} from '../chains/evm/cow-rules'
import { ChainActionRefused, type ChainActionRequest } from '../chains/types'

/**
 * Against Avalanche mainnet and CoW's API, reading and quoting only. A quote creates no order, and
 * nothing here signs or posts one. The owner named is public, from CoW's own auction data, and its
 * key isn't held here. Run by this exact file name.
 */

const API = 'https://api.cow.fi/avalanche/api/v1'
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
/** A Trust Wallet user whose USDC-to-AVAX order filled on 5 November 2026. */
const OWNER = '0x234bdf42ab52da50ae8bd226a7429abf5d1b8626'
const FILLED =
  '0x9615813c04ab2ec6d73868776996f1324f04aedd25b7db3d69309831d562bd75234bdf42ab52da50ae8bd226a7429abf5d1b86266aece9c6'
/** Holds nothing anywhere. */
const NOBODY = '0x00000000000000000000000000000000c0ffee01'
const SLOW_MS = 60_000

const settlement = parseAbi([
  'function domainSeparator() view returns (bytes32)',
  'function vaultRelayer() view returns (address)',
])

const client = createPublicClient({
  chain: avalanche,
  transport: http(process.env['AVALANCHE_RPC_URL']?.trim() || undefined, { timeout: 15_000 }),
})

async function quote(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: NOBODY,
      receiver: NOBODY,
      kind: 'sell',
      appData: COW_APP_DATA,
      appDataHash: COW_APP_DATA_HASH,
      partiallyFillable: true,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      signingScheme: 'eip712',
      ...body,
    }),
  })
}

describe.skipIf(process.env['SKIP_LIVE'] === '1')('CoW on Avalanche, read and quoted only', () => {
  // CoW answers a burst with 429, so each test waits its turn.
  beforeEach(() => new Promise((resolve) => setTimeout(resolve, 4_000)))

  it(
    'has the settlement contract, domain and vault relayer the rules are pinned to',
    async () => {
      const [separator, relayer] = await Promise.all([
        client.readContract({
          address: COW_SETTLEMENT as Address,
          abi: settlement,
          functionName: 'domainSeparator',
        }),
        client.readContract({
          address: COW_SETTLEMENT as Address,
          abi: settlement,
          functionName: 'vaultRelayer',
        }),
      ])
      expect(separator).toBe(
        hashDomain({
          domain: { ...COW_DOMAIN, verifyingContract: COW_SETTLEMENT as Address },
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
          },
        })
      )
      expect(relayer.toLowerCase()).toBe(COW_VAULT_RELAYER.toLowerCase())
    },
    SLOW_MS
  )

  it(
    'finds an owner’s orders at /account/{owner}/orders, and not at /orders?owner=',
    async () => {
      const listed = await fetch(`${API}/account/${OWNER}/orders?limit=5`)
      expect(listed.status).toBe(200)
      const rows = (await listed.json()) as { owner: string; uid: string }[]
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.owner.toLowerCase() === OWNER)).toBe(true)
      const byQuery = await fetch(`${API}/orders?owner=${OWNER}`)
      console.log(`GET /orders?owner= answered ${byQuery.status}`)
      expect(byQuery.status).not.toBe(200)
    },
    SLOW_MS
  )

  it(
    'computes the same order id as CoW for a real filled order',
    async () => {
      const response = await fetch(`${API}/orders/${FILLED}`)
      expect(response.status).toBe(200)
      const row = (await response.json()) as Record<string, unknown>
      const order = {
        sellToken: row['sellToken'],
        buyToken: row['buyToken'],
        receiver: row['receiver'],
        sellAmount: row['sellAmount'],
        buyAmount: row['buyAmount'],
        validTo: row['validTo'],
        appData: row['appData'],
        feeAmount: row['feeAmount'],
        kind: row['kind'],
        partiallyFillable: row['partiallyFillable'],
        sellTokenBalance: row['sellTokenBalance'],
        buyTokenBalance: row['buyTokenBalance'],
      } as unknown as CowOrder
      expect(cowOrderUid(order, String(row['owner']))).toBe(FILLED)
      expect(String(row['buyToken']).toLowerCase()).toBe(COW_BUY_NATIVE.toLowerCase())
      expect(row['status']).toBe('fulfilled')
    },
    SLOW_MS
  )

  it(
    'quotes buying native AVAX through 0xEeee…, so a purchase pays out in AVAX',
    async () => {
      const response = await quote({
        sellToken: USDC,
        buyToken: COW_BUY_NATIVE,
        sellAmountBeforeFee: '10000000',
      })
      const body = (await response.json()) as { quote?: { buyAmount: string; buyToken: string } }
      console.log(`USDC to native AVAX quote: ${response.status} ${JSON.stringify(body.quote)}`)
      expect(response.status).toBe(200)
      expect(body.quote?.buyToken.toLowerCase()).toBe(COW_BUY_NATIVE.toLowerCase())
      expect(BigInt(body.quote?.buyAmount ?? '0') > BigInt(0)).toBe(true)
    },
    SLOW_MS
  )

  it(
    'quotes selling WAVAX for USDC with the empty app data this app signs',
    async () => {
      const response = await quote({
        sellToken: WAVAX,
        buyToken: USDC,
        sellAmountBeforeFee: '1000000000000000000',
      })
      const body = (await response.json()) as { quote?: { appDataHash?: string } }
      console.log(`WAVAX to USDC quote: ${response.status} ${JSON.stringify(body.quote)}`)
      expect(response.status).toBe(200)
      expect(body.quote?.appDataHash?.toLowerCase()).toBe(COW_APP_DATA_HASH.toLowerCase())
    },
    SLOW_MS
  )

  const sale = (amount: string): ChainActionRequest => ({
    kind: 'limit',
    amount,
    tokenIn: 'AVAX',
    tokenOut: 'USDC',
    limitPrice: '20',
  })

  it(
    'prepares only the wrap for a wallet with no WAVAX, building nothing but the step',
    async () => {
      const prepared = await cowVenue.prepare(sale('2'), NOBODY)
      expect(prepared.thenPrepareAgain).toBe(true)
      expect(prepared.context?.['step']).toBe('wrap')
      expect(prepared.signing).toMatchObject({ family: 'evm', to: WAVAX, data: '0xd0e30db0' })
      cowVenue.assertSafe(prepared.signing, NOBODY, prepared.context)
    },
    SLOW_MS
  )

  it(
    'refuses an order too small for CoW’s solvers in the brief’s words',
    async () => {
      const refusal = await cowVenue.prepare(sale('0.000001'), NOBODY).catch((e: unknown) => e)
      expect(refusal).toBeInstanceOf(ChainActionRefused)
      expect((refusal as Error).message).toBe(
        "That is too small for CoW's solvers to fill. Try a few dollars more. Nothing was signed or sent."
      )
    },
    SLOW_MS
  )

  it(
    'reads a real owner’s book, and refuses to cancel an order that has filled',
    async () => {
      const orders = await cowBook().openOrders(OWNER)
      console.log(`book for ${OWNER}: ${JSON.stringify(orders.slice(0, 3))}`)
      expect(orders.every((o) => o.venueId === 'cow-limit')).toBe(true)
      await expect(cowBook().prepareExit(OWNER, FILLED, 'cancel')).rejects.toThrow(/no longer open/)
    },
    SLOW_MS
  )
})
