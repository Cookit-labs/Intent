import { bcs } from '@mysten/sui/bcs'
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'

import { ChainActionRefused } from '../types'
import { cetusOverlay, MAX_SLIPPAGE_BPS } from './cetus-rules'
import { moveTarget, type ParsedCall, type PtbPolicy, type ReadPure } from './safety'
import { SUI_TOKENS } from './tokens'

/**
 * Cetus's aggregator router. This id is the SDK's own `DEFAULT_PUBLISHED_AT.Mainnet`
 * (aggregator-sdk 1.7.5), and the live router API returns the same one.
 */
export const CETUS_ROUTER = '0xffd4058af7d6f6d66c335930cced8c91e38ec943e2392232aee27e8127e684e9'

/**
 * Swap wrappers for the pools routes may use, with the router API's `providers`
 * names. The SDK doesn't list these: it takes `published_at` from the API. So each
 * was read from live routes and checked on chain: published by the router's own
 * deployer (0x2891c6b8...2c47), and `swap` takes `&mut router::SwapContext` from the
 * router's original package (0x33ec64e9...). Their other public functions were read
 * too; none of the listed `swap` functions takes a recipient.
 *
 * Momentum, Aftermath and Ferra wrappers are left out because a different address
 * published them, and Magma and Bolt because the research didn't cover them. Oracle
 * pools are left out so a swap never needs Pyth price updates.
 */
export const CETUS_WRAPPERS = {
  CETUS: ['0x87b17d7f0b448b83ab934a13eb64b05b60e17d0a371e2a721c241bcf3f5ec9e7', 'cetus'],
  CETUSDLMM: ['0x8e094a372cdea3af6ccb58a5fd70689f3000b6101777b24db980fa4e3d740861', 'cetus_dlmm'],
  CETUS_TIDE: ['0xe67d0eb102fc781926ab7e91272e92661baf629653e0525f9b637f9ae5a9218a', 'orderbook'],
  BLUEFIN: ['0x4e7c4ba436f8fd5b3c6bb514880ccd11c5109c83c45b5e037394b94204dbbb80', 'bluefin'],
  TURBOS: ['0x626c8509478fe57ddf69e4141080b062911063f541c55cd0e8d602c6a0874573', 'turbos'],
  FLOWXV3: ['0x66d7bfb7ca9002c4e0a2a8bfb763ca224011be912f24025a52a4e19be0cb0ac0', 'flowx_clmm'],
} as const

export const CETUS_PROVIDERS = Object.keys(CETUS_WRAPPERS)

/**
 * NAVI's lending package (version 26). `getConfig` returns it from NAVI's API, and
 * on chain its `incentive_v3::entry_deposit` takes the `storage::Storage` and
 * `pool::Pool` types that NAVI's live shared objects have, from the original package
 * 0xd899cf7d...81ca. The live test fails when NAVI's config moves away from this id.
 */
export const NAVI_PACKAGE = '0x512f28261c1a293f49416d8885b8d5d32bde6dd68a99a0be36fe42b248e6833a'

const NEW_SWAP_CONTEXT = moveTarget(CETUS_ROUTER, 'router', 'new_swap_context_v3')
/** The contract counts slippage and fees in millionths; a basis point is 100 of them. */
const CONTRACT_UNITS_PER_BPS = 100
const LISTED_COINS: ReadonlySet<string> = new Set(SUI_TOKENS.map((t) => normalizeStructTag(t.id)))

function fail(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

function readNumber(
  read: ReadPure,
  call: ParsedCall,
  index: number,
  type: 'u32' | 'u64',
  label: string
): number {
  const bytes = read(call.arguments[index])
  if (bytes === undefined) return fail(`I couldn't read the ${label} on this swap.`)
  try {
    return Number(type === 'u32' ? bcs.u32().parse(bytes) : bcs.u64().parse(bytes))
  } catch {
    return fail(`I couldn't read the ${label} on this swap.`)
  }
}

/**
 * The router's public entry point takes a fee rate, a fee recipient and a slippage
 * limit, so an allowed contract could still pay someone else or give up the price
 * protection. Arguments: quote id, max in, quote in, quote out, slippage, coin, fee
 * rate, fee recipient.
 */
function checkSwapContext(call: ParsedCall, read: ReadPure): void {
  if (call.target !== NEW_SWAP_CONTEXT) return

  for (const coin of call.typeArguments) {
    if (!LISTED_COINS.has(normalizeStructTag(coin))) {
      fail('This swap involves a token outside the verified list.')
    }
  }

  const slippage = readNumber(read, call, 4, 'u64', 'slippage limit')
  if (slippage > MAX_SLIPPAGE_BPS * CONTRACT_UNITS_PER_BPS) {
    fail(`This swap's slippage limit is over the ${MAX_SLIPPAGE_BPS / 100}% I allow.`)
  }

  const feeRate = readNumber(read, call, 6, 'u32', 'fee')
  if (feeRate === 0) return
  const overlay = cetusOverlay()
  if (overlay === undefined || feeRate > overlay.bps * CONTRACT_UNITS_PER_BPS) {
    fail('This swap charges a fee that was not agreed.')
  }
  const recipient = read(call.arguments[7])
  let paid: string | undefined
  try {
    paid = recipient === undefined ? undefined : normalizeSuiAddress(bcs.Address.parse(recipient))
  } catch {
    paid = undefined
  }
  if (paid !== normalizeSuiAddress(overlay.receiver)) {
    fail('This swap pays its fee to an address that was not agreed.')
  }
}

/**
 * SpringSui's latest package: the `package` field of the UpgradeCap the SDK reads
 * (springsui-sdk 4.1.0, `SPRING_SUI_UPGRADE_CAP_ID` 0x4dc657b6...cd67, version 10).
 * The call names and argument order are the SDK's generated bindings. The sSUI object
 * ids are read from SpringSui's on-chain registry (0x06d6b688...a3f4), not assumed.
 */
export const SPRINGSUI_PACKAGE =
  '0x47c4b62aed92c5ae308ecd00253b64b3568ad97e6fb11e54b3d1ac5ed7be19ab'
export const SSUI_TYPE =
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI'
export const SSUI_INFO = '0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b'
export const SSUI_WEIGHT_HOOK = '0xbbafcb2d7399c0846f8185da3f273ad5b26b3b35993050affa44cfa890f1f144'

/** Anyone can create a token in this package, so the allowed call says nothing about the coin. */
function checkMintsSsui(call: ParsedCall): void {
  for (const coin of call.typeArguments) {
    if (normalizeStructTag(coin) !== normalizeStructTag(SSUI_TYPE)) {
      fail('This stake mints a token other than sSUI.')
    }
  }
}

/** How much sSUI a dry run paid this account, in base units. */
export function mintedAmount(
  changes: readonly { coinType: string; address: string; amount: string }[] | undefined,
  account: string
): string | undefined {
  const paid = changes?.find(
    (c) =>
      normalizeStructTag(c.coinType) === normalizeStructTag(SSUI_TYPE) &&
      normalizeSuiAddress(c.address) === normalizeSuiAddress(account)
  )
  return paid !== undefined && /^\d+$/.test(paid.amount) && BigInt(paid.amount) > BigInt(0)
    ? paid.amount
    : undefined
}

export const SPRINGSUI_POLICY: PtbPolicy = {
  venueName: 'SpringSui',
  allowedCalls: new Set([
    moveTarget(SPRINGSUI_PACKAGE, 'liquid_staking', 'mint'),
    moveTarget(SPRINGSUI_PACKAGE, 'weight', 'rebalance'),
  ]),
  checkCall: checkMintsSsui,
}

export const CETUS_POLICY: PtbPolicy = {
  venueName: 'Cetus',
  allowedCalls: new Set([
    NEW_SWAP_CONTEXT,
    moveTarget(CETUS_ROUTER, 'router', 'confirm_swap_v3'),
    // Takes only the coin and pays the transaction's sender.
    moveTarget(CETUS_ROUTER, 'router', 'transfer_or_destroy_coin'),
    ...Object.values(CETUS_WRAPPERS).map(([pkg, module]) => moveTarget(pkg, module, 'swap')),
  ]),
  checkCall: checkSwapContext,
}

export const NAVI_POLICY: PtbPolicy = {
  venueName: 'NAVI',
  allowedCalls: new Set([moveTarget(NAVI_PACKAGE, 'incentive_v3', 'entry_deposit')]),
}
