import { bcs } from '@mysten/sui/bcs'
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'

import { ChainActionRefused } from '../types'
import { cetusOverlay, MAX_SLIPPAGE_BPS } from './cetus-rules'
import {
  moveTarget,
  type ParsedCall,
  type PtbPolicy,
  type ReadObject,
  type ReadPure,
} from './safety'
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

/**
 * DeepBook core, version 9: the latest package, which is what calls target. `@mysten/deepbook-v3`
 * 2.10.1's `mainnetPackageIds`, and calling it succeeded in simulation on 5 November 2026. An upgrade
 * blocks this venue until the new id is checked and added here.
 */
export const DEEPBOOK_PACKAGE = '0xbca0cefe720330e7bb4f2283438b68de6a0e656688db4ac90d61e71fe6151fe8'
/** The original package, which is where the types are defined, so where objects say they are from. */
const DEEPBOOK_TYPES = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809'
export const DEEPBOOK_MANAGER_TYPE = `${DEEPBOOK_TYPES}::balance_manager::BalanceManager`
export const DEEPBOOK_REGISTRY =
  '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d'
export const DEEPBOOK_REGISTRY_VERSION = '336155480'
/** SUI/USDC, the one pool used. Read off the SDK's `mainnetPools` and checked on chain. */
export const DEEPBOOK_POOL = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407'
export const DEEPBOOK_POOL_VERSION = '389750322'
export const DEEPBOOK_SUI = normalizeStructTag('0x2::sui::SUI')
export const DEEPBOOK_USDC = normalizeStructTag(
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
)
/** The Move constant `POST_ONLY`: the order aborts rather than fill any part at once. */
export const DEEPBOOK_POST_ONLY = 3
/** The Move constant `SELF_MATCHING_ALLOWED`. It only governs a fill, and this order never takes one. */
export const DEEPBOOK_SELF_MATCHING = 0
/** Seven days, as built, plus room for the time between building it and it landing. */
const DEEPBOOK_MAX_EXPIRY_MS = 8 * 24 * 60 * 60 * 1000

export const DEEPBOOK_CALLS = {
  newManager: moveTarget(DEEPBOOK_PACKAGE, 'balance_manager', 'new'),
  deposit: moveTarget(DEEPBOOK_PACKAGE, 'balance_manager', 'deposit'),
  proof: moveTarget(DEEPBOOK_PACKAGE, 'balance_manager', 'generate_proof_as_owner'),
  register: moveTarget(DEEPBOOK_PACKAGE, 'balance_manager', 'register_balance_manager'),
  withdrawAll: moveTarget(DEEPBOOK_PACKAGE, 'balance_manager', 'withdraw_all'),
  place: moveTarget(DEEPBOOK_PACKAGE, 'pool', 'place_limit_order'),
  cancel: moveTarget(DEEPBOOK_PACKAGE, 'pool', 'cancel_order'),
  settle: moveTarget(DEEPBOOK_PACKAGE, 'pool', 'withdraw_settled_amounts'),
  share: moveTarget('0x2', 'transfer', 'public_share_object'),
} as const

function normalizedTypes(types: readonly string[]): string[] | undefined {
  try {
    return types.map((t) => normalizeStructTag(t))
  } catch {
    return undefined
  }
}

function assertDeepbookPool(call: ParsedCall, readObject: ReadObject): void {
  if (readObject(call.arguments[0]) !== DEEPBOOK_POOL) {
    fail('This order is on a different market than the one you asked for.')
  }
  const [base, quote, ...rest] = normalizedTypes(call.typeArguments) ?? []
  if (base !== DEEPBOOK_SUI || quote !== DEEPBOOK_USDC || rest.length !== 0) {
    fail('This order trades other tokens than SUI and USDC.')
  }
}

function deepbookNumber(read: ReadPure, call: ParsedCall, index: number, what: string): bigint {
  const bytes = read(call.arguments[index])
  if (bytes === undefined) return fail(`I couldn't read the ${what} on this order.`)
  try {
    return BigInt(bcs.u64().parse(bytes))
  } catch {
    return fail(`I couldn't read the ${what} on this order.`)
  }
}

/**
 * What holds for every DeepBook call whatever was asked. Who owns the manager is not in the bytes, and
 * a deposit, proof or withdrawal aborts for anyone but its owner. `deepbookAssertSafe` then holds the
 * transaction to the figures it was built with.
 */
function checkDeepbookCall(
  call: ParsedCall,
  read: ReadPure,
  _account: string,
  readObject: ReadObject
): void {
  switch (call.target) {
    case DEEPBOOK_CALLS.place: {
      assertDeepbookPool(call, readObject)
      const orderType = read(call.arguments[4])
      if (
        orderType === undefined ||
        orderType.length !== 1 ||
        orderType[0] !== DEEPBOOK_POST_ONLY
      ) {
        fail('This order could fill at once, and it must only rest.')
      }
      const matching = read(call.arguments[5])
      if (
        matching === undefined ||
        matching.length !== 1 ||
        matching[0] !== DEEPBOOK_SELF_MATCHING
      ) {
        fail('This order matches against your own in a way I did not check.')
      }
      const payWithDeep = read(call.arguments[9])
      if (payWithDeep === undefined || payWithDeep.length !== 1 || payWithDeep[0] !== 0) {
        fail('This order pays its fee in a way I did not check.')
      }
      const expiry = deepbookNumber(read, call, 10, 'expiry')
      if (expiry > BigInt(Date.now() + DEEPBOOK_MAX_EXPIRY_MS)) {
        fail('This order lasts past the 8 days I allow.')
      }
      return
    }
    case DEEPBOOK_CALLS.cancel:
    case DEEPBOOK_CALLS.settle:
      assertDeepbookPool(call, readObject)
      return
    case DEEPBOOK_CALLS.deposit:
    case DEEPBOOK_CALLS.withdrawAll: {
      const [coin, ...rest] = normalizedTypes(call.typeArguments) ?? []
      if ((coin !== DEEPBOOK_SUI && coin !== DEEPBOOK_USDC) || rest.length !== 0) {
        fail('This order trades other tokens than SUI and USDC.')
      }
      return
    }
    case DEEPBOOK_CALLS.register:
      if (readObject(call.arguments[1]) !== DEEPBOOK_REGISTRY) {
        fail('This transaction writes to a different DeepBook registry.')
      }
      return
    case DEEPBOOK_CALLS.share: {
      const [shared, ...rest] = normalizedTypes(call.typeArguments) ?? []
      if (shared !== normalizeStructTag(DEEPBOOK_MANAGER_TYPE) || rest.length !== 0) {
        fail('This transaction shares something other than your DeepBook account.')
      }
      return
    }
    default:
      return
  }
}

/**
 * Exactly what placing, cancelling and collecting use. Left out, because each hands control of a
 * manager to another address: `mint_trade_cap`, `mint_deposit_cap`, `mint_withdraw_cap` and
 * `new_with_custom_owner`. The framework's `public_share_object` is allowed only for a manager.
 */
export const DEEPBOOK_POLICY: PtbPolicy = {
  venueName: 'DeepBook',
  allowedCalls: new Set(Object.values(DEEPBOOK_CALLS)),
  checkCall: checkDeepbookCall,
}
