import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The allowlist follows the network.
 *
 * Every exported name keeps its meaning — "Soroswap's router", "Blend's
 * pool" — and resolves to that contract on the network the deployment is
 * pointed at. A testnet id is not on the mainnet allowlist, and a mainnet
 * id not on testnet's: a signature is only ever handed to a contract this
 * app has reviewed *on the network it is about to be broadcast to*.
 *
 * Where no mainnet id could be verified from the venue's own documentation
 * or deployment repository, the constant is `undefined` there and the venue
 * is simply absent from the allowlist. Nothing is guessed.
 */

const TESTNET = {
  soroswapRouter: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
  soroswapAggregator: 'CC74XDT7UVLUZCELKBIYXFYIX6A6LGPWURJVUXGRPQO745RWX7WEURMA',
  aquariusRouter: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD',
  blendPool: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',
  noetherMarket: 'CBHHWFAYLB3SXJCE232DC6WNSK74IBEOROAGCI2AFBA2H5NQOH2KYKNN',
  noetherRouter: 'CBDVQKYEN6QMRGQZC77DFYEQXQHDMCVJ3TPBJKNERJVMIESA6GQT44LG',
  reflectorCexDex: 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63',
  reflectorFx: 'CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W',
  xlmSac: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  usdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
}

const MAINNET = {
  soroswapRouter: 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
  soroswapAggregator: 'CAYP3UWLJM7ZPTUKL6R6BFGTRWLZ46LRKOXTERI2K6BIJAWGYY62TXTO',
  aquariusRouter: 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK',
  blendPool: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  reflectorCexDex: 'CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN',
  reflectorFx: 'CBKGPWGKSKZF52CFHMTRR23TBWTPMRDIYZ4O2P5VS65BMHYH4DXMCJZC',
  xlmSac: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
  usdcSac: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
}

type Loaded = {
  registry: typeof import('../swap/contract-registry')
  reflector: typeof import('../prices/reflector')
  reserves: typeof import('../lend/reserves')
  soroswap: typeof import('../swap/sources/soroswap-quoter')
}

async function load(network: 'testnet' | 'mainnet'): Promise<Loaded> {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', network)
  const [registry, reflector, reserves, soroswap] = await Promise.all([
    import('../swap/contract-registry'),
    import('../prices/reflector'),
    import('../lend/reserves'),
    import('../swap/sources/soroswap-quoter'),
  ])
  return { registry, reflector, reserves, soroswap }
}

// Loaded once per network rather than per test: each load re-imports the
// SDK-backed modules from scratch, which is slow with the whole suite running.
let loaded: Record<'testnet' | 'mainnet', Loaded>

beforeAll(async () => {
  loaded = { testnet: await load('testnet'), mainnet: await load('mainnet') }
  vi.unstubAllEnvs()
}, 60_000)

function on(network: 'testnet' | 'mainnet'): Promise<Loaded> {
  return Promise.resolve(loaded[network])
}

afterAll(() => {
  vi.resetModules()
})

describe('on testnet, nothing moved', () => {
  it('pins the ids the app has always used', async () => {
    const { registry, reflector, reserves, soroswap } = await on('testnet')
    expect(registry.SOROSWAP_ROUTER).toBe(TESTNET.soroswapRouter)
    expect(registry.SOROSWAP_AGGREGATOR).toBe(TESTNET.soroswapAggregator)
    expect(registry.AQUARIUS_ROUTER).toBe(TESTNET.aquariusRouter)
    expect(registry.BLEND_POOL).toBe(TESTNET.blendPool)
    expect(registry.NOETHER_MARKET).toBe(TESTNET.noetherMarket)
    expect(registry.NOETHER_ROUTER).toBe(TESTNET.noetherRouter)
    expect(reflector.REFLECTOR_CEX_DEX).toBe(TESTNET.reflectorCexDex)
    expect(reflector.REFLECTOR_FX).toBe(TESTNET.reflectorFx)
    expect(reserves.BLEND_XLM).toBe(TESTNET.xlmSac)
    expect(soroswap.SOROSWAP_ROUTER).toBe(TESTNET.soroswapRouter)
    expect(soroswap.SOROSWAP_CONTRACTS).toEqual({ XLM: TESTNET.xlmSac, USDC: TESTNET.usdcSac })
    expect(registry.blendPositionUrl()).toBe(
      `https://testnet.blend.capital/dashboard/?poolId=${TESTNET.blendPool}`
    )
  })

  it('does not know the mainnet contracts', async () => {
    const { registry } = await on('testnet')
    expect(registry.lookupContract(MAINNET.soroswapRouter)).toBeUndefined()
    expect(registry.lookupContract(MAINNET.blendPool)).toBeUndefined()
  })
})

describe('on mainnet', () => {
  it('resolves every verified id to its mainnet contract', async () => {
    const { registry, reflector, reserves, soroswap } = await on('mainnet')
    expect(registry.SOROSWAP_ROUTER).toBe(MAINNET.soroswapRouter)
    expect(registry.SOROSWAP_AGGREGATOR).toBe(MAINNET.soroswapAggregator)
    expect(registry.AQUARIUS_ROUTER).toBe(MAINNET.aquariusRouter)
    expect(registry.BLEND_POOL).toBe(MAINNET.blendPool)
    expect(reflector.REFLECTOR_CEX_DEX).toBe(MAINNET.reflectorCexDex)
    expect(reflector.REFLECTOR_FX).toBe(MAINNET.reflectorFx)
    expect(reserves.BLEND_XLM).toBe(MAINNET.xlmSac)
    expect(soroswap.SOROSWAP_ROUTER).toBe(MAINNET.soroswapRouter)
    expect(soroswap.SOROSWAP_CONTRACTS).toEqual({ XLM: MAINNET.xlmSac, USDC: MAINNET.usdcSac })
  })

  it('leaves Noether undefined, because it has no mainnet deployment', async () => {
    const { registry } = await on('mainnet')
    expect(registry.NOETHER_MARKET).toBeUndefined()
    expect(registry.NOETHER_ROUTER).toBeUndefined()
    // And the allowlist has no entry for it: a call to its testnet market
    // is refused, not narrated as a perp order.
    const out = registry.labelForCall(TESTNET.noetherMarket, 'open_position')
    expect(out.ok).toBe(false)
  })

  it('allowlists only the venues that are on mainnet, and refuses the testnet ids', async () => {
    const { registry } = await on('mainnet')
    expect(registry.lookupContract(MAINNET.soroswapRouter)?.label).toBe('Swap via Soroswap')
    expect(registry.labelForCall(MAINNET.soroswapRouter, 'swap_exact_tokens_for_tokens')).toEqual({
      ok: true,
      label: 'Swap via Soroswap',
    })

    // Verified ids, but their venues are not on mainnet at launch, so a call
    // to any of them is refused rather than narrated as a swap or a supply.
    expect(registry.lookupContract(MAINNET.aquariusRouter)).toBeUndefined()
    expect(registry.lookupContract(MAINNET.blendPool)).toBeUndefined()
    expect(registry.lookupContract(MAINNET.soroswapAggregator)).toBeUndefined()
    expect(
      registry.labelForCall(MAINNET.soroswapAggregator, 'swap_exact_tokens_for_tokens').ok
    ).toBe(false)

    expect(registry.lookupContract(TESTNET.soroswapRouter)).toBeUndefined()
    const out = registry.labelForCall(TESTNET.soroswapRouter, 'swap_exact_tokens_for_tokens')
    expect(out.ok).toBe(false)
  })

  it('links a Blend position to the mainnet dashboard', async () => {
    const { registry } = await on('mainnet')
    expect(registry.blendPositionUrl()).toBe(
      `https://mainnet.blend.capital/dashboard/?poolId=${MAINNET.blendPool}`
    )
  })
})
