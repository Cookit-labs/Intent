import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import type { ReviewedVault } from '../chains/evm/erc4626'
import { ChainActionRefused, type ChainVenue, type SigningPayload } from '../chains/types'

export const ACCOUNT = '0x1111111111111111111111111111111111111111'
export const STRANGER = '0x2222222222222222222222222222222222222222'
const OTHER_TOKEN = '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'
const FIVE = BigInt(5_000_000)

const ABI = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function mint(uint256 shares, address receiver) returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export function depositData(receiver: string = ACCOUNT, assets: bigint = FIVE): string {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'deposit',
    args: [assets, receiver as Address],
  })
}

export function withdrawData(receiver: string = ACCOUNT, owner: string = ACCOUNT): string {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'withdraw',
    args: [FIVE, receiver as Address, owner as Address],
  })
}

export function redeemData(
  shares: bigint = FIVE,
  receiver: string = ACCOUNT,
  owner: string = ACCOUNT
): string {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'redeem',
    args: [shares, receiver as Address, owner as Address],
  })
}

export function approveData(spender: string, units: bigint = FIVE): string {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender as Address, units],
  })
}

/** The same refusals for every vault on this path, proved on each venue's own policy. */
export function describeVaultRefusals(
  venue: ChainVenue,
  vault: ReviewedVault,
  chainId: number,
  offList: readonly string[]
): void {
  const payload = (overrides: Partial<Extract<SigningPayload, { family: 'evm' }>> = {}) => ({
    family: 'evm' as const,
    chainId,
    to: vault.address,
    data: depositData(),
    value: '0',
    ...overrides,
  })
  const approval = (to: string, data: string) => payload({ approval: { to, data } })

  describe(`${venue.id} assertSafe`, () => {
    it('passes a deposit and a withdrawal for the person', () => {
      expect(() => venue.assertSafe(payload(), ACCOUNT)).not.toThrow()
      expect(() => venue.assertSafe(payload({ data: withdrawData() }), ACCOUNT)).not.toThrow()
    })

    it('passes a redeem of the shares, to and from the person', () => {
      expect(() => venue.assertSafe(payload({ data: redeemData() }), ACCOUNT)).not.toThrow()
      expect(() => venue.assertSafe(payload({ data: redeemData() }), STRANGER)).toThrow(
        ChainActionRefused
      )
    })

    it('passes a deposit with an exact approval of the vault', () => {
      const signing = approval(vault.asset.id, approveData(vault.address))
      expect(() => venue.assertSafe(signing, ACCOUNT)).not.toThrow()
    })

    it.each<[string, SigningPayload]>([
      ['another family', { family: 'sui', transaction: 'AA==' }],
      ['another chain', payload({ chainId: chainId + 1 })],
      ['native value', payload({ value: '1' })],
      ['a deposit crediting someone else', payload({ data: depositData(STRANGER) })],
      ['a withdrawal paying someone else', payload({ data: withdrawData(STRANGER) })],
      ['a withdrawal from someone else', payload({ data: withdrawData(ACCOUNT, STRANGER) })],
      ['a deposit of nothing', payload({ data: depositData(ACCOUNT, BigInt(0)) })],
      ['extra calldata', payload({ data: `${depositData()}00` })],
      ['calldata that decodes as nothing', payload({ data: '0xdeadbeef' })],
      ['a redeem paying someone else', payload({ data: redeemData(FIVE, STRANGER) })],
      ['a redeem from someone else', payload({ data: redeemData(FIVE, ACCOUNT, STRANGER) })],
      ['a redeem of nothing', payload({ data: redeemData(BigInt(0)) })],
      ['a redeem naming no amount', payload({ data: redeemData(maxUint256) })],
      ['a redeem with extra data', payload({ data: `${redeemData()}00` })],
      [
        'an approval beside a redeem',
        payload({
          data: redeemData(),
          approval: { to: vault.asset.id, data: approveData(vault.address) },
        }),
      ],
      [
        'mint, which is not allowed',
        payload({
          data: encodeFunctionData({
            abi: ABI,
            functionName: 'mint',
            args: [FIVE, ACCOUNT as Address],
          }),
        }),
      ],
      [
        'moving the shares',
        payload({
          data: encodeFunctionData({
            abi: ABI,
            functionName: 'transfer',
            args: [STRANGER as Address, FIVE],
          }),
        }),
      ],
      [
        'approving someone to take the shares',
        payload({
          data: encodeFunctionData({
            abi: ABI,
            functionName: 'approve',
            args: [STRANGER as Address, FIVE],
          }),
        }),
      ],
      ['the token itself as the target', payload({ to: vault.asset.id })],
      ['an unlimited approval', approval(vault.asset.id, approveData(vault.address, maxUint256))],
      ['an approval of a stranger', approval(vault.asset.id, approveData(STRANGER))],
      ['an approval of the wrong token', approval(OTHER_TOKEN, approveData(vault.address))],
      [
        'an approval for another amount',
        approval(vault.asset.id, approveData(vault.address, BigInt(6))),
      ],
      ['an approval with extra data', approval(vault.asset.id, `${approveData(vault.address)}00`)],
      [
        'a first step that pays someone',
        approval(
          vault.asset.id,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [STRANGER as Address, FIVE],
          })
        ),
      ],
      [
        'an approval beside a withdrawal',
        payload({
          data: withdrawData(),
          approval: { to: vault.asset.id, data: approveData(vault.address) },
        }),
      ],
    ])('refuses %s', (_label, signing) => {
      expect(() => venue.assertSafe(signing, ACCOUNT)).toThrow(ChainActionRefused)
    })

    it('refuses a transaction built for another account', () => {
      expect(() => venue.assertSafe(payload(), STRANGER)).toThrow(ChainActionRefused)
      expect(() => venue.assertSafe(payload({ data: withdrawData() }), STRANGER)).toThrow(
        ChainActionRefused
      )
    })

    it.each(offList.map((address) => [address]))('refuses the vault off the list at %s', (to) => {
      expect(() => venue.assertSafe(payload({ to }), ACCOUNT)).toThrow(ChainActionRefused)
    })

    it('refuses a token this vault does not take', async () => {
      const request = { kind: 'supply' as const, amount: '5', tokenIn: 'USDT' }
      await expect(venue.prepare(request, ACCOUNT)).rejects.toThrow(/takes USDC/)
      await expect(venue.quote?.(request, ACCOUNT)).rejects.toThrow(/takes USDC/)
    })

    it('refuses an account that is not an address', async () => {
      const request = { kind: 'supply' as const, amount: '5', tokenIn: 'USDC' }
      await expect(venue.prepare(request, 'not-an-address')).rejects.toThrow(ChainActionRefused)
    })

    it('refuses a kind it does not run', async () => {
      const request = { kind: 'borrow' as const, amount: '5', tokenIn: 'USDC' }
      await expect(venue.prepare(request, ACCOUNT)).rejects.toThrow(ChainActionRefused)
    })

    it('can only supply after a swap, and only its own token', async () => {
      await expect(
        venue.assertCanFollow?.({ kind: 'supply', tokenIn: 'USDC' }, ACCOUNT)
      ).resolves.toBeUndefined()
      await expect(
        venue.assertCanFollow?.({ kind: 'supply', tokenIn: 'USDT' }, ACCOUNT)
      ).rejects.toThrow(ChainActionRefused)
      await expect(
        venue.assertCanFollow?.({ kind: 'withdraw', tokenIn: 'USDC' }, ACCOUNT)
      ).rejects.toThrow(ChainActionRefused)
    })
  })
}
