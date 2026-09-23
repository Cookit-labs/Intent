import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { applySlippage, resolveAsset, type ClassicAsset } from '../swap/assets'
import {
  assertAggregatorSwap,
  buildAggregatorSwap,
  type AggregatorExpectation,
} from '../swap/build-aggregator'
import { sacFor } from '../swap/build-soroban'
import { SOROSWAP_AGGREGATOR, SOROSWAP_ROUTER } from '../swap/contract-registry'
import type { AggregatorApiQuote, ApiResult, SoroswapApi } from '../swap/soroswap-api'
import type { AggregatorQuoted } from '../swap/sources/soroswap-aggregator-quoter'

/**
 * The transaction the aggregator API returns is not trusted; it is read.
 *
 * Every other builder in this app constructs its own envelope and then
 * re-reads it. This one receives an envelope built by somebody else's
 * server, which makes the re-read the *only* check between a network
 * response and a wallet prompt. So each field the API could get wrong — or
 * a compromised API could get wrong on purpose — is substituted here on its
 * own, against an otherwise perfect envelope, and must be refused by name.
 *
 * Three shapes, because the API decides per quote which contract fills the
 * swap: the aggregator (seven arguments, recipient sixth), Soroswap's router
 * alone (five, recipient fourth), or a classic path payment for the order
 * book. The validator refuses a shape that does not match the platform the
 * quote named, so a swap quoted as a split cannot be signed as a payment.
 *
 * Argument layouts are from the contracts' source: the aggregator's
 * `swap_exact_tokens_for_tokens(token_in, token_out, amount_in,
 * amount_out_min, distribution, to, deadline)` and the router's
 * `(amount_in, amount_out_min, path, to, deadline)`.
 */

const ME = 'GAJ74DIC3252BKBTDCEYTDA2ZYDRDBDT3QMZU5IW2HOZQBYVXMRZZEFA'
const STRANGER = 'GAWWM4J4W3ZNGFQR4ULIQCNY44EHLBLVARBHM5CSXOGJYGZVDIBFGVC5'
/** A well-formed contract id the registry has never heard of. */
const UNKNOWN_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

const xlm = resolveAsset('XLM')
const usdc = resolveAsset('USDC')
if (xlm === undefined || usdc === undefined) throw new Error('registry missing XLM or USDC')
const XLM: ClassicAsset = xlm
const USDC: ClassicAsset = usdc
const XLM_SAC = sacFor(XLM)
const USDC_SAC = sacFor(USDC)

const AMOUNT_IN = '300000000'
const AMOUNT_OUT = '9067253'
/** What the API wrote as its floor at 50 bps: inside the tolerance. */
const FLOOR = '9021917'
const NOW = 1_800_000_000
const DEADLINE = NOW + 300

const clock = { nowSeconds: () => NOW }

function expectation(over: Partial<AggregatorExpectation> = {}): AggregatorExpectation {
  return {
    platform: 'aggregator',
    contractId: SOROSWAP_AGGREGATOR,
    assetIn: XLM_SAC,
    assetOut: USDC_SAC,
    from: XLM,
    to: USDC,
    amountIn: AMOUNT_IN,
    amountOut: AMOUNT_OUT,
    slippageBps: 50,
    ...over,
  }
}

/** A `DexDistribution` struct as the contract encodes it. */
function distribution(path: string[], protocolId = 0): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('bytes'), val: xdr.ScVal.scvVoid() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('parts'), val: xdr.ScVal.scvU32(10) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('path'),
      val: xdr.ScVal.scvVec(path.map((c) => new Address(c).toScVal())),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('protocol_id'),
      val: xdr.ScVal.scvU32(protocolId),
    }),
  ])
}

function envelope(source: string, ops: xdr.Operation[]): string {
  const builder = new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
  for (const op of ops) builder.addOperation(op)
  return builder.setTimeout(180).build().toXDR()
}

interface AggregatorCallOptions {
  source?: string
  contract?: string
  fn?: string
  tokenIn?: string
  tokenOut?: string
  amountIn?: string
  floor?: string
  distributionPath?: string[]
  to?: string
  deadline?: number
  argCount?: number
  opSource?: string
  extraOp?: boolean
}

/** An aggregator `swap_exact_tokens_for_tokens`, every argument overridable. */
function aggregatorCall(o: AggregatorCallOptions = {}): string {
  const args: xdr.ScVal[] = [
    new Address(o.tokenIn ?? XLM_SAC).toScVal(),
    new Address(o.tokenOut ?? USDC_SAC).toScVal(),
    nativeToScVal(BigInt(o.amountIn ?? AMOUNT_IN), { type: 'i128' }),
    nativeToScVal(BigInt(o.floor ?? FLOOR), { type: 'i128' }),
    xdr.ScVal.scvVec([distribution(o.distributionPath ?? [XLM_SAC, USDC_SAC])]),
    new Address(o.to ?? ME).toScVal(),
    nativeToScVal(BigInt(o.deadline ?? DEADLINE), { type: 'u64' }),
  ].slice(0, o.argCount ?? 7)

  const contract = o.contract ?? SOROSWAP_AGGREGATOR
  const fn = o.fn ?? 'swap_exact_tokens_for_tokens'
  const call = new Contract(contract).call(fn, ...args)
  const op =
    o.opSource === undefined
      ? call
      : Operation.invokeContractFunction({
          contract,
          function: fn,
          args,
          auth: [],
          source: o.opSource,
        })
  const ops = o.extraOp === true ? [op, call] : [op]
  return envelope(o.source ?? ME, ops)
}

interface RouterCallOptions {
  path?: string[]
  to?: string
  floor?: string
  contract?: string
}

/** A router `swap_exact_tokens_for_tokens`: five arguments, recipient fourth. */
function routerCall(o: RouterCallOptions = {}): string {
  const args: xdr.ScVal[] = [
    nativeToScVal(BigInt(AMOUNT_IN), { type: 'i128' }),
    nativeToScVal(BigInt(o.floor ?? FLOOR), { type: 'i128' }),
    xdr.ScVal.scvVec((o.path ?? [XLM_SAC, USDC_SAC]).map((c) => new Address(c).toScVal())),
    new Address(o.to ?? ME).toScVal(),
    nativeToScVal(BigInt(DEADLINE), { type: 'u64' }),
  ]
  return envelope(ME, [
    new Contract(o.contract ?? SOROSWAP_ROUTER).call('swap_exact_tokens_for_tokens', ...args),
  ])
}

interface PathPaymentOptions {
  destination?: string
  destMin?: string
  destAsset?: Asset
  sendAmount?: string
}

/** The classic shape the API builds for an `sdex` plan. */
function pathPayment(o: PathPaymentOptions = {}): string {
  return envelope(ME, [
    Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount: o.sendAmount ?? '30.0000000',
      destination: o.destination ?? ME,
      destAsset: o.destAsset ?? new Asset('USDC', USDC.issuer as string),
      destMin: o.destMin ?? '0.9021917',
      path: [],
    }),
  ])
}

describe('an aggregator call is admitted only when every field is the quote', () => {
  it('accepts a call paying the signer, and reads the floor out of the bytes', () => {
    const checked = assertAggregatorSwap(aggregatorCall(), ME, expectation(), clock)

    expect(checked.floor).toBe(FLOOR)
    expect(checked.recipient).toBe(ME)
    expect(checked.label).toBe('Swap via Soroswap aggregator')
  })

  it('refuses a call that pays somebody else', () => {
    // The substitution that matters most. Everything else about this
    // envelope is exactly right, and it would hand the proceeds to a stranger.
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ to: STRANGER }), ME, expectation(), clock)
    ).toThrow(/pays .* not the signing account/)
  })

  it('refuses a call to a contract other than the one the quote named', () => {
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ contract: SOROSWAP_ROUTER }), ME, expectation(), clock)
    ).toThrow(/not the contract the quote named/)
  })

  it('refuses a contract the registry has not reviewed, even if the quote named it', () => {
    // The registry is the allowlist. A rotated contract must not become
    // signable by being resolved at runtime and echoed back here.
    expect(() =>
      assertAggregatorSwap(
        aggregatorCall({ contract: UNKNOWN_CONTRACT }),
        ME,
        expectation({ contractId: UNKNOWN_CONTRACT }),
        clock
      )
    ).toThrow(/not a contract this app calls/)
  })

  it('refuses a function that is not the fixed-input swap', () => {
    // `swap_tokens_for_exact_tokens` is in the registry, and is still the
    // wrong call for a quote that fixed the input: its arguments mean
    // different things in the same positions.
    expect(() =>
      assertAggregatorSwap(
        aggregatorCall({ fn: 'swap_tokens_for_exact_tokens' }),
        ME,
        expectation(),
        clock
      )
    ).toThrow(/swap_exact_tokens_for_tokens/)
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ fn: 'update_adapters' }), ME, expectation(), clock)
    ).toThrow(/update_adapters/)
  })

  it('refuses an input amount that differs from the quote', () => {
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ amountIn: '300000001' }), ME, expectation(), clock)
    ).toThrow(/spends 300000001, not the 300000000 quoted/)
  })

  it('refuses a floor below the slippage tolerance', () => {
    const tooLow = (BigInt(applySlippage(AMOUNT_OUT, 50)) - BigInt(1)).toString()
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ floor: tooLow }), ME, expectation(), clock)
    ).toThrow(/floor .* below/)
  })

  it('refuses a floor above the quoted output', () => {
    // A floor the route cannot clear is a transaction that fails after a
    // signature, which is a wallet prompt for nothing.
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ floor: '9067254' }), ME, expectation(), clock)
    ).toThrow(/floor .* above/)
  })

  it('refuses a deadline already in the past', () => {
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ deadline: NOW - 1 }), ME, expectation(), clock)
    ).toThrow(/deadline/)
  })

  it('refuses tokens that differ from the quote', () => {
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ tokenOut: XLM_SAC }), ME, expectation(), clock)
    ).toThrow(/delivers .* not the .* quoted/)
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ tokenIn: USDC_SAC }), ME, expectation(), clock)
    ).toThrow(/spends .* not the .* quoted/)
  })

  it('refuses a distribution leg that does not start and end at the quoted assets', () => {
    expect(() =>
      assertAggregatorSwap(
        aggregatorCall({ distributionPath: [XLM_SAC, UNKNOWN_CONTRACT] }),
        ME,
        expectation(),
        clock
      )
    ).toThrow(/distribution/)
  })

  it('refuses the wrong number of arguments', () => {
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ argCount: 6 }), ME, expectation(), clock)
    ).toThrow(/seven arguments/)
  })
})

describe('the envelope around the call', () => {
  it('refuses a second operation', () => {
    // A second operation beside the one the user reviewed is exactly what
    // the plan validator exists to catch; a single-swap builder catches it
    // by refusing anything but one.
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ extraOp: true }), ME, expectation(), clock)
    ).toThrow(/exactly one operation/)
  })

  it('refuses a transaction sourced from another account', () => {
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ source: STRANGER }), ME, expectation(), clock)
    ).toThrow(/transaction source/)
  })

  it('refuses an operation sourced from another account', () => {
    expect(() =>
      assertAggregatorSwap(aggregatorCall({ opSource: STRANGER }), ME, expectation(), clock)
    ).toThrow(/sourced from/)
  })

  it('refuses a fee-bump', () => {
    const inner = TransactionBuilder.fromXDR(aggregatorCall(), Networks.TESTNET)
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      STRANGER,
      '1000',
      inner as never,
      Networks.TESTNET
    ).toXDR()
    expect(() => assertAggregatorSwap(bump, ME, expectation(), clock)).toThrow(/fee-bump/)
  })
})

describe('a router-only plan', () => {
  const router = expectation({ platform: 'router', contractId: SOROSWAP_ROUTER })

  it('accepts a router call paying the signer', () => {
    const checked = assertAggregatorSwap(routerCall(), ME, router, clock)
    expect(checked.floor).toBe(FLOOR)
    expect(checked.label).toBe('Swap via Soroswap')
  })

  it('refuses a router call paying somebody else', () => {
    expect(() => assertAggregatorSwap(routerCall({ to: STRANGER }), ME, router, clock)).toThrow(
      /pays .* not the signing account/
    )
  })

  it('refuses a path that does not start and end at the quoted assets', () => {
    expect(() =>
      assertAggregatorSwap(routerCall({ path: [XLM_SAC, UNKNOWN_CONTRACT] }), ME, router, clock)
    ).toThrow(/path/)
  })

  it('refuses the aggregator when the quote said router', () => {
    // The two contracts take different argument layouts. Reading one as the
    // other would check the wrong positions and could pass a call it should
    // not.
    expect(() => assertAggregatorSwap(aggregatorCall(), ME, router, clock)).toThrow(
      /not the contract the quote named/
    )
  })
})

describe('a classic-DEX plan', () => {
  const sdex = expectation({ platform: 'sdex', contractId: undefined })

  it('accepts a path payment to the signer within tolerance', () => {
    const checked = assertAggregatorSwap(pathPayment(), ME, sdex, clock)
    expect(checked.floor).toBe(FLOOR)
    expect(checked.recipient).toBe(ME)
  })

  it('refuses a payment to somebody else', () => {
    expect(() =>
      assertAggregatorSwap(pathPayment({ destination: STRANGER }), ME, sdex, clock)
    ).toThrow(/pays .* not the signing account/)
  })

  it('refuses a payment in a different asset', () => {
    expect(() =>
      assertAggregatorSwap(pathPayment({ destAsset: new Asset('USDC', STRANGER) }), ME, sdex, clock)
    ).toThrow(/delivers/)
  })

  it('refuses a floor below tolerance', () => {
    expect(() =>
      assertAggregatorSwap(pathPayment({ destMin: '0.0000001' }), ME, sdex, clock)
    ).toThrow(/floor .* below/)
  })

  it('refuses a different input amount', () => {
    expect(() =>
      assertAggregatorSwap(pathPayment({ sendAmount: '31.0000000' }), ME, sdex, clock)
    ).toThrow(/spends/)
  })

  it('refuses a contract call when the quote said classic', () => {
    expect(() => assertAggregatorSwap(aggregatorCall(), ME, sdex, clock)).toThrow(
      /not a path payment/
    )
  })

  it('refuses a path payment when the quote said aggregator', () => {
    expect(() => assertAggregatorSwap(pathPayment(), ME, expectation(), clock)).toThrow(
      /not a contract invocation/
    )
  })
})

describe('building through the API', () => {
  const raw: AggregatorApiQuote = {
    assetIn: XLM_SAC,
    assetOut: USDC_SAC,
    amountIn: AMOUNT_IN,
    amountOut: AMOUNT_OUT,
    otherAmountThreshold: FLOOR,
    platform: 'aggregator',
    routePlan: [{ protocol: 'soroswap', path: [XLM_SAC, USDC_SAC], percent: '100' }],
    raw: {},
  }

  const quoted: AggregatorQuoted = {
    quote: {
      source: 'soroswap-aggregator',
      kind: 'strict_send',
      from: XLM,
      to: USDC,
      sendAmount: AMOUNT_IN,
      destAmount: AMOUNT_OUT,
      path: [],
      platform: 'aggregator',
      quotedAt: new Date().toISOString(),
    },
    raw,
    aggregatorId: SOROSWAP_AGGREGATOR,
    protocols: ['soroswap', 'aqua', 'sdex'],
    slippageBps: 50,
  }

  function apiReturning(build: ApiResult<string>): SoroswapApi & { buildCalls: unknown[] } {
    const api = {
      buildCalls: [] as unknown[],
      isConfigured: () => true,
      async quote(): Promise<ApiResult<AggregatorApiQuote>> {
        return { ok: false, reason: 'upstream_error' as const, detail: 'not under test' }
      },
      async build(q: AggregatorApiQuote, account: string): Promise<ApiResult<string>> {
        api.buildCalls.push({ q, account })
        return build
      },
      async contractAddress(name: string): Promise<string | undefined> {
        return name === 'router' ? SOROSWAP_ROUTER : SOROSWAP_AGGREGATOR
      },
    }
    return api
  }

  it('returns the checked envelope with the floor read from it', async () => {
    const api = apiReturning({ ok: true, value: aggregatorCall() })

    const built = await buildAggregatorSwap({
      account: ME,
      quoted,
      api,
      nowSeconds: clock.nowSeconds,
    })

    expect(built.xdr).toBe(aggregatorCall())
    expect(built.floor).toBe(FLOOR)
    expect(built.recipient).toBe(ME)
    expect(built.platform).toBe('aggregator')
    expect(api.buildCalls).toEqual([{ q: raw, account: ME }])
    // Carried out so the route can run the same check again on the bytes
    // that come back from simulation, which are the ones a wallet sees.
    expect(built.expectation.contractId).toBe(SOROSWAP_AGGREGATOR)
    expect(built.expectation.amountIn).toBe(AMOUNT_IN)
  })

  it('refuses what the API built when it pays somebody else', async () => {
    const api = apiReturning({ ok: true, value: aggregatorCall({ to: STRANGER }) })

    await expect(
      buildAggregatorSwap({ account: ME, quoted, api, nowSeconds: clock.nowSeconds })
    ).rejects.toThrow(/pays .* not the signing account/)
  })

  it('reports the API failing to build', async () => {
    const api = apiReturning({ ok: false, reason: 'no_route', detail: 'Route expired' })

    await expect(
      buildAggregatorSwap({ account: ME, quoted, api, nowSeconds: clock.nowSeconds })
    ).rejects.toThrow(/Route expired/)
  })

  it('checks a router plan against the router id resolved at build time', async () => {
    const api = apiReturning({ ok: true, value: routerCall() })
    const routerQuoted: AggregatorQuoted = {
      ...quoted,
      quote: { ...quoted.quote, platform: 'router' },
      raw: { ...raw, platform: 'router' },
    }

    const built = await buildAggregatorSwap({
      account: ME,
      quoted: routerQuoted,
      api,
      nowSeconds: clock.nowSeconds,
    })

    expect(built.platform).toBe('router')
    expect(built.label).toBe('Swap via Soroswap')
  })
})
