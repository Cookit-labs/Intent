import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  approvalNote,
  assertEvmCallSafe,
  buildEvmCall,
  confirmEvmCall,
  type EvmCallPolicy,
  type EvmReaderClient,
} from '../chains/evm/call'
import type { EvmClient, EvmReceipt } from '../chains/evm/client'
import { sameAddress } from '../chains/evm/submit'
import { ChainActionRefused, type SigningPayload } from '../chains/types'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const STRANGER = '0x2222222222222222222222222222222222222222'
const CONTRACT = '0x3333333333333333333333333333333333333333'
const OTHER_CONTRACT = '0x4444444444444444444444444444444444444444'
const TOKEN = '0x5555555555555555555555555555555555555555'
const AVALANCHE_ID = 43114
const HASH = `0x${'a'.repeat(64)}`

const ABI = parseAbi([
  'function put(address token, uint256 amount, address onBehalfOf)',
  'function sweep(address to)',
])

const POLICY: EvmCallPolicy = {
  venueName: 'Test',
  chain: 'avalanche',
  contracts: {
    [CONTRACT]: {
      abi: ABI,
      functions: ['put'],
      check: (call, { account, approval }) => {
        const [, amount, onBehalfOf] = call.args as [string, bigint, string]
        if (!sameAddress(onBehalfOf, account)) {
          throw new ChainActionRefused('This credits someone else.')
        }
        if (approval !== undefined && approval.units !== amount) {
          throw new ChainActionRefused('The approval does not match.')
        }
      },
    },
  },
  spenders: [CONTRACT],
  approvable: [TOKEN],
}

function put(onBehalfOf: string = ACCOUNT, amount = BigInt(5)): string {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'put',
    args: [TOKEN as Address, amount, onBehalfOf as Address],
  })
}

function approve(spender: string = CONTRACT, units = BigInt(5)): string {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender as Address, units],
  })
}

function payload(overrides: Partial<Extract<SigningPayload, { family: 'evm' }>> = {}) {
  return {
    family: 'evm' as const,
    chainId: AVALANCHE_ID,
    to: CONTRACT,
    data: put(),
    value: '0',
    ...overrides,
  }
}

describe('assertEvmCallSafe', () => {
  it('passes the call the venue is confirmed to make', () => {
    expect(() => assertEvmCallSafe(payload(), ACCOUNT, POLICY)).not.toThrow()
  })

  it('passes an exact approval to a confirmed spender', () => {
    const signing = payload({ approval: { to: TOKEN, data: approve() } })
    expect(() => assertEvmCallSafe(signing, ACCOUNT, POLICY)).not.toThrow()
  })

  it.each<[string, SigningPayload]>([
    ['another family', { family: 'sui', transaction: 'AA==' }],
    ['another chain', payload({ chainId: 143 })],
    ['an unknown contract', payload({ to: OTHER_CONTRACT })],
    [
      'a function it may not call',
      payload({
        data: encodeFunctionData({ abi: ABI, functionName: 'sweep', args: [STRANGER as Address] }),
      }),
    ],
    ['calldata that decodes as nothing', payload({ data: '0xdeadbeef' })],
    ['anything after the arguments', payload({ data: `${put()}00` })],
    ['credit to someone else', payload({ data: put(STRANGER) })],
    ['native value it may not take', payload({ value: '1' })],
    ['a value that is not digits', payload({ value: '0x1' })],
    [
      'an unlimited approval',
      payload({ approval: { to: TOKEN, data: approve(CONTRACT, maxUint256) } }),
    ],
    ['an approval to a stranger', payload({ approval: { to: TOKEN, data: approve(STRANGER) } })],
    [
      'an approval of an unlisted token',
      payload({ approval: { to: OTHER_CONTRACT, data: approve() } }),
    ],
    [
      'an approval with trailing data',
      payload({ approval: { to: TOKEN, data: `${approve()}00` } }),
    ],
    [
      'a first step that is a transfer',
      payload({
        approval: {
          to: TOKEN,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [STRANGER as Address, BigInt(5)],
          }),
        },
      }),
    ],
    [
      'an approval larger than the call',
      payload({ approval: { to: TOKEN, data: approve(CONTRACT, BigInt(6)) } }),
    ],
  ])('refuses %s', (_label, signing) => {
    expect(() => assertEvmCallSafe(signing, ACCOUNT, POLICY)).toThrow(ChainActionRefused)
  })

  it('lets value through only where the venue takes the native coin', () => {
    const native = { ...POLICY, mayPayNative: true }
    expect(() => assertEvmCallSafe(payload({ value: '1' }), ACCOUNT, native)).not.toThrow()
  })
})

function fakeReader(allowance: bigint, callFails = false): EvmReaderClient {
  return {
    readContract: async () => allowance,
    call: async () => {
      if (callFails) throw new Error('reverted')
      return { data: '0x' }
    },
  } as unknown as EvmReaderClient
}

const PLAN = {
  chain: 'avalanche' as const,
  account: ACCOUNT,
  to: CONTRACT,
  data: put(),
  pull: { token: TOKEN, spender: CONTRACT, units: BigInt(5) },
}

describe('buildEvmCall', () => {
  it('asks for an exact approval only when the allowance falls short', async () => {
    const { signing, needsApproval } = await buildEvmCall(PLAN, fakeReader(BigInt(4)))
    expect(needsApproval).toBe(true)
    expect(signing).toMatchObject({ approval: { to: TOKEN, data: approve() } })
  })

  it('leaves the approval off when one is in place', async () => {
    const { signing, needsApproval } = await buildEvmCall(PLAN, fakeReader(BigInt(5)))
    expect(needsApproval).toBe(false)
    expect(signing).not.toHaveProperty('approval')
  })

  it('refuses a call that would fail, rather than costing the gas', async () => {
    await expect(buildEvmCall(PLAN, fakeReader(BigInt(5), true))).rejects.toThrow(
      ChainActionRefused
    )
  })

  it("doesn't try a call whose approval hasn't landed, which would fail for that alone", async () => {
    await expect(buildEvmCall(PLAN, fakeReader(BigInt(0), true))).resolves.toMatchObject({
      needsApproval: true,
    })
  })

  it('says the wallet will ask twice, for how much', () => {
    expect(approvalNote('Test', '5', 'USDC')).toContain('exactly 5 USDC')
  })
})

function fakeClient(
  receipt: Partial<EvmReceipt> | Error,
  sent: { input: string; value: bigint } | Error = { input: put(), value: BigInt(0) }
): EvmClient {
  return {
    tokenBalance: async () => BigInt(0),
    nativeBalance: async () => BigInt(0),
    allowance: async () => BigInt(0),
    code: async () => undefined,
    waitForReceipt: async () => {
      if (receipt instanceof Error) throw receipt
      return { status: 'success', from: ACCOUNT, to: CONTRACT, logs: [], ...receipt } as EvmReceipt
    },
    transaction: async () => {
      if (sent instanceof Error) throw sent
      return sent
    },
  }
}

const SIGNED = { family: 'evm' as const, hash: HASH }

describe('confirmEvmCall', () => {
  it('settles a landed call that is this venue’s, from this person', async () => {
    const result = await confirmEvmCall(POLICY, ACCOUNT, SIGNED, fakeClient({}))
    expect(result).toMatchObject({ ok: true, hash: HASH })
  })

  it('says funds did not move only for a proven revert of this very call', async () => {
    const result = await confirmEvmCall(POLICY, ACCOUNT, SIGNED, fakeClient({ status: 'reverted' }))
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('pending')
  })

  it.each<[string, EvmClient]>([
    ['a receipt that has not come', fakeClient(new Error('timeout'))],
    ['another person’s transaction', fakeClient({ from: STRANGER })],
    ['a contract creation', fakeClient({ to: null })],
    ['another contract', fakeClient({ to: OTHER_CONTRACT })],
    ['a transaction that can’t be read', fakeClient({}, new Error('rpc'))],
    [
      'a call that credits someone else',
      fakeClient({}, { input: put(STRANGER), value: BigInt(0) }),
    ],
    [
      'a revert that is not this call',
      fakeClient({ status: 'reverted' }, { input: put(STRANGER), value: BigInt(0) }),
    ],
  ])('stays pending for %s, since the money may have moved', async (_label, client) => {
    const result = await confirmEvmCall(POLICY, ACCOUNT, SIGNED, client)
    expect(result).toMatchObject({ ok: false, pending: true })
  })

  it('stays pending when the wallet gave no usable hash', async () => {
    const result = await confirmEvmCall(
      POLICY,
      ACCOUNT,
      { family: 'evm', hash: 'nope' },
      fakeClient({})
    )
    expect(result).toMatchObject({ ok: false, pending: true })
  })
})
