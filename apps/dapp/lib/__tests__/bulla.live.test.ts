import { http, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  BULLA_CLAIM,
  BULLA_INVOICE,
  BULLA_OWNER,
  BULLA_READ_ABI,
  createBullaVenue,
} from '../chains/evm/bulla'
import { evmReader } from '../chains/evm/client'

/**
 * Read-only against Avalanche mainnet: nothing is signed or sent. These hold the card's claims to
 * the chain, so a moved owner, a new fee or a lock shows up here before a person reads a stale note.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const RPC =
  process.env['AVALANCHE_RPC_URL']?.trim() || 'https://avalanche-c-chain-rpc.publicnode.com'
const reader = evmReader('avalanche', http(RPC, { timeout: 20_000, retryCount: 2 }))
const BILLER = '0x1111111111111111111111111111111111111111'
const CLIENT = '0x2222222222222222222222222222222222222222'

describe.skipIf(SKIP)('Bulla on Avalanche', { timeout: 60_000 }, () => {
  const read = (address: Address, functionName: never) =>
    reader.readContract({ address, abi: BULLA_READ_ABI, functionName } as never) as Promise<unknown>

  it('has code at each pinned contract', async () => {
    for (const address of [BULLA_CLAIM, BULLA_INVOICE]) {
      const code = await reader.getCode({ address: address as Address })
      expect((code ?? '0x').length).toBeGreaterThan(2)
    }
  })

  it('wires BullaInvoice to this claim contract', async () => {
    expect(await read(BULLA_INVOICE as Address, '_bullaClaim' as never)).toBe(BULLA_CLAIM)
  })

  it('is owned by the single key the card names', async () => {
    expect(await read(BULLA_CLAIM as Address, 'owner' as never)).toBe(BULLA_OWNER)
    expect(await read(BULLA_INVOICE as Address, 'owner' as never)).toBe(BULLA_OWNER)
    expect(await reader.getCode({ address: BULLA_OWNER as Address })).toBeUndefined()
  })

  it('is unlocked, and charges no fee', async () => {
    expect(await read(BULLA_CLAIM as Address, 'lockState' as never)).toBe(0)
    expect(await read(BULLA_CLAIM as Address, 'CORE_PROTOCOL_FEE' as never)).toBe(BigInt(0))
    expect(await read(BULLA_INVOICE as Address, 'protocolFeeBPS' as never)).toBe(0)
  })

  it('refuses to pay an invoice that is not there', async () => {
    await expect(
      createBullaVenue(reader).prepare(
        { kind: 'pay_invoice', amount: '1', tokenIn: 'USDC', invoiceId: '999999999' },
        BILLER
      )
    ).rejects.toThrow(/no invoice 999999999/)
  })

  it('accepts the bill this venue builds, and refuses it from anyone else', async () => {
    const prepared = await createBullaVenue(reader).prepare(
      { kind: 'invoice', amount: '500', tokenIn: 'USDC', recipient: CLIENT, dueDate: '2099-12-01' },
      BILLER
    )
    if (prepared.signing.family !== 'evm') throw new Error('not evm')
    const data = prepared.signing.data as Hex
    await expect(
      reader.call({ account: BILLER, to: BULLA_CLAIM as Address, data })
    ).resolves.toBeDefined()
    await expect(
      reader.call({
        account: '0x3333333333333333333333333333333333333333',
        to: BULLA_CLAIM as Address,
        data,
      })
    ).rejects.toThrow()
  })
})
