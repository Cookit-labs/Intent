import { bcs } from '@mysten/sui/bcs'
import { coinWithBalance, Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { ReserveDataInfo, UserStateInfo } from '@naviprotocol/lending'

import {
  tokenBySymbol,
  toBaseUnits,
  type ChainActionRequest,
  type ChainToken,
  type PreparedAction,
  type SigningPayload,
  type VenuePosition,
} from '../types'
import { assertSuiAccount, buildUnsigned, suiClient } from './client'
import {
  assertBorrowFits,
  assertCallsPinned,
  assertWithdrawFits,
  borrowNotes,
  dryRunChange,
  gaveWhatWasAsked,
  pinnedPolicy,
  readPythObject,
  refuse,
  repayCoinAmount,
  walletBalance,
  withdrawLoanNote,
  type LoanStanding,
  type PinnedCall,
  type PinnedCalls,
} from './lending-calls'
import { NAVI_PACKAGE } from './policies'
import { assertPtbSafe, moveTarget } from './safety'
import { displayAmount, SUI_TOKENS } from './tokens'

/**
 * NAVI's `/navi/config` and `/navi/pools`, what @naviprotocol/lending's `getConfig` and
 * `getPools` return. Pinned rather than read each time, so getting money out doesn't
 * depend on NAVI's server. On chain each is a shared object of the type
 * `incentive_v3::entry_withdraw` and `oracle_pro::update_single_price_v3` declare, and
 * the live test fails when NAVI's config moves away from any of them.
 */
export const NAVI_STORAGE = '0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe'
export const NAVI_INCENTIVE_V2 =
  '0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c'
export const NAVI_INCENTIVE_V3 =
  '0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80'
export const NAVI_PRICE_ORACLE =
  '0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef'
export const NAVI_USDC_POOL = '0xa3582097b4c57630046c0c49a88bfc6b202a3ec0a9db5597c31765f7563755a8'
export const NAVI_USDC_ASSET_ID = 10
export const NAVI_ORACLE_PACKAGE =
  '0x4837ae94425107554c8847721cf9954c1ad8e10520433b9e37dc11c507148bea'
export const NAVI_ORACLE_CONFIG =
  '0x1afe1cb83634f581606cc73c4487ddd8cc39a944b951283af23f7d69d5589478'
export const NAVI_SUPRA_HOLDER =
  '0xaa0315f0748c1f24ddb2b45f7939cff40f7a8104af5ccbc4a1d32f870c0b4105'
export const NAVI_SWITCHBOARD = '0x1fa7566f40f93cdbafd5a029a231e06664219444debb59beec2fe3f19ca08b7e'
export const NAVI_USDC_PYTH_OBJECT =
  '0x6ddfc6f9921e55998cbc2e68f78eba897981d79ac17f66c5277bc38954a2a3f8'
export const NAVI_USDC_FEED = '0xe120611435395f144b4bcc4466a00b6b26d7a27318f96e148648852a9dd6b31c'
/** `uiGetter` in NAVI's config. Read only: nothing here signs a call to it. */
export const NAVI_UI_GETTER = '0x74c2e735aa13768048f8b8b46855a93d9e242ea3336c17e72720197e9675ae35'

/** The listed tokens NAVI has a pool for. */
export const NAVI_ASSETS: readonly { symbol: string; assetId: number; pool: string }[] = [
  {
    symbol: 'SUI',
    assetId: 0,
    pool: '0x96df0fce3c471489f4debaaa762cf960b3d97820bd1f3f025ff8190730e958c5',
  },
  { symbol: 'USDC', assetId: NAVI_USDC_ASSET_ID, pool: NAVI_USDC_POOL },
  {
    symbol: 'USDT',
    assetId: 19,
    pool: '0xa3e0471746e5d35043801bce247d3b3784cc74329d39f7ed665446ddcf22a9e2',
  },
  {
    symbol: 'WAL',
    assetId: 24,
    pool: '0xef76883525f5c2ff90cd97732940dbbdba0b391e29de839b10588cee8e4fe167',
  },
  {
    symbol: 'USDsui',
    assetId: 34,
    pool: '0xb0da1bf1702e919a3d5182939944435ccfd1b1facd92acb273007c3f09f42201',
  },
]

/**
 * Asset id, NAVI's feed id and its Pyth price object, for every asset NAVI has. A position's
 * whole holding must be priced before a borrow or a withdraw, whatever it holds. Pinned so the
 * call can't be pointed elsewhere, and the live test fails when NAVI's config moves away.
 */
export const NAVI_FEEDS: readonly (readonly [number, string, string])[] = [
  [
    0,
    '0x2cab9b151ca1721624b09b421cc57d0bb26a1feb5da1f821492204b098ec35c9',
    '0x89b2add829cb6fcd017153fff428bc9faec4d06d643ecfc435af5b55a9e987f0',
  ],
  [
    1,
    '0x70a79226dda5c080378b639d1bb540ddea64761629aa4ad7355d79266d55af61',
    '0x6ddfc6f9921e55998cbc2e68f78eba897981d79ac17f66c5277bc38954a2a3f8',
  ],
  [
    2,
    '0xf72d8933873bb4e5bfa1edbfa9ff6443ec5fac25c1d99ba2ef37f50a125826f3',
    '0x939e666c48cfac89418f69a24cb857263d4c520f90d94ea0770e295b9857961e',
  ],
  [
    3,
    '0x44d92366eba1f1652ec81f34585406726bef267565a2db1664ffd5ef18e21693',
    '0x88d7ef5396b1f885ed347f97f3b58daae8a424122668e96bdb4ee847cff62adf',
  ],
  [
    4,
    '0x5ac98fc1e6723af2a6d9a68a5d771654a6043f9c4d2b836b2d5fb4832a3be4f2',
    '0xb14bce71ba7e52cd52947f236604ece40f7a58a1cdf0435c8b94cf6f2d84d302',
  ],
  [
    5,
    '0x086bb5540047b3c77ae5e2f9b811c7ef085517a73510f776753c8ee83d19e62c',
    '0x89b2add829cb6fcd017153fff428bc9faec4d06d643ecfc435af5b55a9e987f0',
  ],
  [
    6,
    '0xac934a2a2d406085e7f73b460221fe1b11935864605ba58cdbb8e21c15f12acd',
    '0x89b2add829cb6fcd017153fff428bc9faec4d06d643ecfc435af5b55a9e987f0',
  ],
  [
    7,
    '0x4324c797d2f19eff517c24adec8b92aa2d282e44f3a5cafb36d6c4b30d7f2dca',
    '0x9b9aeb630697368ca228f3353b34b4f4b1bbc1fbdbd7417b01765cb93013de12',
  ],
  [
    8,
    '0x1bf4727242a61d892feef6616d3e40a3bd24b64b5deb884054e86cb9360556c4',
    '0xe64832d1b4c9a75139a7313aee69da891297d8397fda2863b5bdcc4af0b79758',
  ],
  [
    9,
    '0x9a0656e1e10a0cdf3f03dce9db9ad931f51dc6eac2e52ebfbf535dfbcf8100ef',
    '0xfaec36b7b45f96ed1b949ed45758dfa73d071f48509e550eec41ad3cfa00d1bd',
  ],
  [10, NAVI_USDC_FEED, NAVI_USDC_PYTH_OBJECT],
  [
    11,
    '0x9a6ffc707270286e98e8d0f654ce38f69efbc302ac98e2deb11fbad2211600f0',
    '0x88d7ef5396b1f885ed347f97f3b58daae8a424122668e96bdb4ee847cff62adf',
  ],
  [
    12,
    '0x11ddf2ac1868d493e2487deeb2a0c2791bb7ca69632c8c5fefe85e09390be093',
    '0xc2510434d7228514383b8ed25aff3f50a7ba58df50345f8fc3b06bf64e4e1397',
  ],
  [
    13,
    '0xc771ec0ca245857f30195ce05197a7b3ab41c58c1e8abe0661919d90675ad63d',
    '0xea0d962a2b2cb35bbc262514ea6cfed02fdb3d5bedb193ca0d50bfefc98abebc',
  ],
  [
    14,
    '0xdf9b254a7a64742e1edf8c48bd2a1f182b52f020de2ab070ae0e3f9228d05280',
    '0xe64832d1b4c9a75139a7313aee69da891297d8397fda2863b5bdcc4af0b79758',
  ],
  [
    15,
    '0x4558092b08ad1b33b0eb536f91a4655693c2390ac568f06de6f6fad827888600',
    '0x562957f70afaf8a0870e2959abc3e3f327a8159f803d8c56cff27ac2df260477',
  ],
  [
    16,
    '0x843b39829166bd97d61843b8967405f13d443e066ce2f4fa0685f187974d34bd',
    '0xf905acf04bac920b667192ea97ea82e615e6a640167b05dcd090df27d85a3ca2',
  ],
  [
    17,
    '0xd8286c11df7e49496ee75622ae4132c56385c30b4bedb392e36c0699a52a1d52',
    '0xa805253ead74e084d8aecb0f215bec90642d61c6015e339dc26a08ddebd88098',
  ],
  [
    18,
    '0x93c1b815f64ef7c4311d74ff7c0ca1e47739c3ac31fdee0068c30887633ba2fb',
    '0xef4889b34aa4a76bfc90189eac8781d397de224441a5139e4955577c2b6dd5e0',
  ],
  [
    19,
    '0xdeba21105ff41300f8829aaeba45fdec25d1533a64d504ef0348ff005da3fbe5',
    '0x939e666c48cfac89418f69a24cb857263d4c520f90d94ea0770e295b9857961e',
  ],
  [
    20,
    '0xd7a8c920db9f8b5c3c300307d88fca53684fd15b760977dbf8f0adc6e55783bd',
    '0x89b2add829cb6fcd017153fff428bc9faec4d06d643ecfc435af5b55a9e987f0',
  ],
  [
    21,
    '0x4e4666c82c476f0b51b27c5ed8c77ab960aa5e4c3a48796e179d721b471e3b7e',
    '0xe64832d1b4c9a75139a7313aee69da891297d8397fda2863b5bdcc4af0b79758',
  ],
  [
    22,
    '0x2611dff736233a6855e28ae95f8e5f62a6bf80653ddb118bf012fd783d530fa1',
    '0x24a14523bbc266db0d4f68dab179f416e86848365de2bfe45490af920709e876',
  ],
  [
    23,
    '0x8ee4d9d61d0bfa342cdb3ee8b7f047c91f0b586e0ff66fd6e8fc761e235e5409',
    '0x9eaebfc21b14ea517575097e7787fe73ab92113525d7ad9acce983a2ae2570dc',
  ],
  [
    24,
    '0x924bf9f715d857605f9f4146537fffc0414809c85845ce9d695f3645a22a5426',
    '0xdbea8600eeeb0399df58c28e73b8201ae880a954813131d33bfa6902ccdadd24',
  ],
  [
    25,
    '0xe8a90eed4e6de66e114e6d00802852a9529054a33de0e8460ec37109f0d09d5e',
    '0xcdefc25e55d4faa895874395989407d3b464fe7cf79110155c8f0a770fb9734a',
  ],
  [
    26,
    '0xbe3a049bbbdc596cc6109fcff0bc2c968e7533bcc675e5718f7ecdf3c5dae506',
    '0xe64832d1b4c9a75139a7313aee69da891297d8397fda2863b5bdcc4af0b79758',
  ],
  [
    27,
    '0xebe4e84fd1b1e28622274640c1bce7f4d79f43e95c6f54bec3880781b88a0d92',
    '0xa40bb30164a63496efaf53c48a72c6fb3bdb2eb03d399510b16a67eb5f3a437e',
  ],
  [
    28,
    '0xc7f87ba22d24e8ce5764f05f775c10f87fc04e2a411c6ad7922fc936e8f7b8e3',
    '0xe64832d1b4c9a75139a7313aee69da891297d8397fda2863b5bdcc4af0b79758',
  ],
  [
    29,
    '0x1d7e07f8fcc6a51d55d69f425cdc84c23807aeac6516dc5d909fe537d7c6eeb1',
    '0xe64832d1b4c9a75139a7313aee69da891297d8397fda2863b5bdcc4af0b79758',
  ],
  [
    30,
    '0x9efc82d7786261800fa78fa347e1b39bf3d3808e4a3e192fb3677fa78a324928',
    '0xe64832d1b4c9a75139a7313aee69da891297d8397fda2863b5bdcc4af0b79758',
  ],
  [
    31,
    '0x5fc8ae7618a0c1551d0e5f5879d144ae5862a070f6a87c6c21c18dae3cb0645b',
    '0xb81afb56abc903ce2c6f7e96fa8fbe3fc66d4ed9dbd9027a7d16d15dca387366',
  ],
  [
    32,
    '0xc0dddc22b53142a0b283682d9025e22c8beedf20dcac4023229d5219e8d35a43',
    '0xe64832d1b4c9a75139a7313aee69da891297d8397fda2863b5bdcc4af0b79758',
  ],
  [
    33,
    '0x70b92bcacfbd260b7564871a0a75c2cc4317fcc95aeeb041714d26e168d887be',
    '0x6ddfc6f9921e55998cbc2e68f78eba897981d79ac17f66c5277bc38954a2a3f8',
  ],
  [
    34,
    '0xfe7130d93f535676c57684091256d3351f78050ae071d865d415b1c9664faaa4',
    '0x6ddfc6f9921e55998cbc2e68f78eba897981d79ac17f66c5277bc38954a2a3f8',
  ],
  [
    35,
    '0xc0f2fc8a96871d85544ee5c14dfddfa0136f2eb3da63464280cf1afa135f2efc',
    '0x33087ad61539d981c8e81e5eada06d9f8c7c9f64b857e26288e496fbd8402975',
  ],
  [
    36,
    '0x52cfd911140f9820db1072208e676bf1a9bf779fdec47b64e28df499c6006101',
    '0x5d61dcc28ea4dc9c16bdff03e5364e0135349ce70b83acf5ecbe843b515f787e',
  ],
  [
    37,
    '0x0830910e7e83ca7de3c1f5f26496881517dc8045e3f4cc57f989d2ae13521155',
    '0xbfeafba9ed1927db1a787c9dd2ef81bc6ef6f6ee259cd4e7ef9e506b152ef9c5',
  ],
  [
    38,
    '0xea5744ee70509808537d4984c30851bdf287690f2b2b9749d8252d83c67ad0b2',
    '0x83e14cbd7140c0f5fe099d9b399cd93e6d6a6ecbefb4d2464fe6dfc72b168123',
  ],
  [
    39,
    '0x0715740f9905c4d0d1120199507d486df45ce44ddfa16f7e2b8389eef97e57d0',
    '0xe64832d1b4c9a75139a7313aee69da891297d8397fda2863b5bdcc4af0b79758',
  ],
]

const FEED_BY_ASSET = new Map(NAVI_FEEDS.map(([id, feed, pyth]) => [id, { feed, pyth }]))

const CLOCK = '0x0000000000000000000000000000000000000000000000000000000000000006'
const SUI_SYSTEM = '0x0000000000000000000000000000000000000000000000000000000000000005'
const SUI_SYMBOL = 'SUI'
const ENTRY_DEPOSIT = moveTarget(NAVI_PACKAGE, 'incentive_v3', 'entry_deposit')
const ENTRY_WITHDRAW = moveTarget(NAVI_PACKAGE, 'incentive_v3', 'entry_withdraw')
const ENTRY_WITHDRAW_V2 = moveTarget(NAVI_PACKAGE, 'incentive_v3', 'entry_withdraw_v2')
const ENTRY_BORROW_V2 = moveTarget(NAVI_PACKAGE, 'incentive_v3', 'entry_borrow_v2')
const ENTRY_REPAY = moveTarget(NAVI_PACKAGE, 'incentive_v3', 'entry_repay')
const UPDATE_PRICE = moveTarget(NAVI_ORACLE_PACKAGE, 'oracle_pro', 'update_single_price_v3')

function coinTypeOf(symbol: string): string {
  const token = SUI_TOKENS.find((t) => t.symbol === symbol)
  if (token === undefined) throw new Error(`${symbol} is missing from the Sui token table.`)
  return token.id
}

function assetBytes(assetId: number): string {
  return toBase64(bcs.u8().serialize(assetId).toBytes())
}

function withdrawPin(asset: (typeof NAVI_ASSETS)[number], argumentCount: number): PinnedCall {
  return {
    typeArguments: [coinTypeOf(asset.symbol)],
    argumentCount,
    objects: {
      1: NAVI_PRICE_ORACLE,
      2: NAVI_STORAGE,
      3: asset.pool,
      6: NAVI_INCENTIVE_V2,
      7: NAVI_INCENTIVE_V3,
      ...(argumentCount === 9 ? { 8: SUI_SYSTEM } : {}),
    },
    pure: { 4: assetBytes(asset.assetId) },
  }
}

const USDC_ASSET = NAVI_ASSETS.find((a) => a.symbol === 'USDC')
if (USDC_ASSET === undefined) throw new Error('USDC is missing from the NAVI assets.')
const SUI_ASSET = NAVI_ASSETS.find((a) => a.symbol === SUI_SYMBOL)
if (SUI_ASSET === undefined) throw new Error('SUI is missing from the NAVI assets.')

/**
 * None of these names a recipient: the contract pays the sender, and a repay can only reduce the
 * sender's own debt. Only listed pools are allowed, each with its own type and asset id, so a call
 * can't point at another reserve. `update_single_price_v3` moves no money. It only copies a price
 * into NAVI's oracle. `entry_withdraw` can't unstake, so SUI leaves through `entry_withdraw_v2`.
 */
const PINS: PinnedCalls = new Map<string, PinnedCall | readonly PinnedCall[]>([
  [
    ENTRY_DEPOSIT,
    {
      typeArguments: [coinTypeOf('USDC')],
      argumentCount: 8,
      objects: { 1: NAVI_STORAGE, 2: NAVI_USDC_POOL, 6: NAVI_INCENTIVE_V2, 7: NAVI_INCENTIVE_V3 },
      pure: { 3: assetBytes(NAVI_USDC_ASSET_ID) },
    },
  ],
  [
    ENTRY_WITHDRAW,
    NAVI_ASSETS.filter((asset) => asset.symbol !== SUI_SYMBOL).map((asset) =>
      withdrawPin(asset, 8)
    ),
  ],
  [ENTRY_WITHDRAW_V2, withdrawPin(SUI_ASSET, 9)],
  [ENTRY_BORROW_V2, NAVI_ASSETS.map((asset) => withdrawPin(asset, 9))],
  [
    ENTRY_REPAY,
    NAVI_ASSETS.map((asset) => ({
      typeArguments: [coinTypeOf(asset.symbol)],
      argumentCount: 9,
      objects: {
        1: NAVI_PRICE_ORACLE,
        2: NAVI_STORAGE,
        3: asset.pool,
        7: NAVI_INCENTIVE_V2,
        8: NAVI_INCENTIVE_V3,
      },
      pure: { 4: assetBytes(asset.assetId) },
    })),
  ],
  [
    UPDATE_PRICE,
    NAVI_FEEDS.map(([, feed, pyth]) => ({
      typeArguments: [],
      argumentCount: 7,
      objects: {
        1: NAVI_ORACLE_CONFIG,
        2: NAVI_PRICE_ORACLE,
        3: NAVI_SUPRA_HOLDER,
        4: pyth,
        5: NAVI_SWITCHBOARD,
      },
      pure: { 6: toBase64(bcs.Address.serialize(feed).toBytes()) },
    })),
  ],
])

export const NAVI_EXIT_POLICY = pinnedPolicy('NAVI', PINS)

export function assertNaviSafe(payload: SigningPayload, account: string): void {
  assertPtbSafe(payload, account, NAVI_EXIT_POLICY)
  assertCallsPinned(payload, PINS, 'NAVI')
}

export interface NaviReserve {
  ltv: number
  liquidationThreshold: number
  borrowAprPercent: number | undefined
}

/** A wallet on NAVI, read now. Amounts are base units of each token, interest included. */
export interface NaviAccount {
  supplied: ReadonlyMap<number, bigint>
  owed: ReadonlyMap<number, bigint>
  reserves: ReadonlyMap<number, NaviReserve>
}

/** Chain reads, kept apart so the refusals can be tested without a network. */
export interface NaviReader {
  account: (account: string) => Promise<NaviAccount>
  /** The position in dollars, with every listed asset priced first. */
  standing: (account: string, assetIds: readonly number[]) => Promise<LoanStanding>
  priceUsd: (assetId: number) => Promise<number>
  borrowFeePercent: (account: string, assetId: number) => Promise<number>
  walletBalance: (account: string, coinType: string) => Promise<bigint>
}

const RAY = BigInt(10) ** BigInt(27)
const WAD = BigInt(10) ** BigInt(18)
const POOL_DECIMALS = 9
const SECONDS_PER_YEAR = 31_536_000
const USD_SCALE = 1e9
const RAY_SCALE = 1e27

async function simulateReads(
  account: string,
  build: (tx: Transaction) => void
): Promise<Uint8Array[]> {
  const tx = new Transaction()
  tx.setSender(account)
  build(tx)
  const { Transaction: result, commandResults } = await suiClient().core.simulateTransaction({
    transaction: tx,
    checksEnabled: false,
    include: { effects: true, commandResults: true },
  })
  if (result?.effects?.status.success !== true || commandResults === undefined) {
    throw new Error("A read of NAVI's contracts did not run.")
  }
  return commandResults.flatMap((c) => c.returnValues.map((v) => v.bcs))
}

function priceUpdate(tx: Transaction, assetId: number): void {
  const entry = FEED_BY_ASSET.get(assetId)
  if (entry === undefined) throw new Error(`NAVI asset ${assetId} has no pinned feed.`)
  tx.moveCall({
    target: UPDATE_PRICE,
    arguments: [
      tx.object(CLOCK),
      tx.object(NAVI_ORACLE_CONFIG),
      tx.object(NAVI_PRICE_ORACLE),
      tx.object(NAVI_SUPRA_HOLDER),
      tx.object(entry.pyth),
      tx.object(NAVI_SWITCHBOARD),
      tx.pure.address(entry.feed),
    ],
  })
}

/** Interest since a reserve last moved, as the contract's `update_state` would add it. */
function accrued(
  scaled: bigint,
  index: bigint,
  ratePerYear: bigint,
  sinceMs: bigint,
  nowMs: number,
  compound: boolean
): bigint {
  const elapsed = Math.max(0, (nowMs - Number(sinceMs)) / 1000)
  const growth = (Number(ratePerYear) / RAY_SCALE) * (elapsed / SECONDS_PER_YEAR)
  const factor = compound ? 1 + growth + (growth * growth) / 2 : 1 + growth
  const factorWad = BigInt(Math.round(factor * 1e18))
  return (((scaled * index) / RAY) * factorWad) / WAD
}

const DECIMALS_BY_ASSET = new Map(
  NAVI_ASSETS.map((asset) => [
    asset.assetId,
    SUI_TOKENS.find((t) => t.symbol === asset.symbol)?.decimals ?? POOL_DECIMALS,
  ])
)

/** NAVI counts every pool in nine decimals. Debt rounds up, and what comes back rounds down. */
function poolToBase(normal: bigint, assetId: number, roundUp: boolean): bigint {
  const decimals = DECIMALS_BY_ASSET.get(assetId) ?? POOL_DECIMALS
  const unit = BigInt(10) ** BigInt(POOL_DECIMALS - decimals)
  return (normal + (roundUp ? unit - BigInt(1) : BigInt(0))) / unit
}

export const naviChainReader: NaviReader = {
  account: async (account) => {
    const [stateBytes, reserveBytes] = await simulateReads(account, (tx) => {
      tx.moveCall({
        target: `${NAVI_UI_GETTER}::getter_unchecked::get_user_state`,
        arguments: [tx.object(NAVI_STORAGE), tx.pure.address(account)],
      })
      tx.moveCall({
        target: `${NAVI_UI_GETTER}::getter::get_reserve_data`,
        arguments: [tx.object(NAVI_STORAGE)],
      })
    })
    if (stateBytes === undefined || reserveBytes === undefined) {
      throw new Error("NAVI's getter returned nothing.")
    }
    const state = bcs.vector(UserStateInfo).parse(stateBytes)
    const data = bcs.vector(ReserveDataInfo).parse(reserveBytes)
    const now = Date.now()
    const reserves = new Map(data.map((r) => [r.id, r]))
    const supplied = new Map<number, bigint>()
    const owed = new Map<number, bigint>()
    for (const row of state) {
      const reserve = reserves.get(row.asset_id)
      if (reserve === undefined) throw new Error(`NAVI has no reserve ${row.asset_id}.`)
      const since = BigInt(reserve.last_update_at)
      if (BigInt(row.supply_balance) > BigInt(0)) {
        const normal = accrued(
          BigInt(row.supply_balance),
          BigInt(reserve.supply_index),
          BigInt(reserve.supply_rate),
          since,
          now,
          false
        )
        supplied.set(row.asset_id, poolToBase(normal, row.asset_id, false))
      }
      if (BigInt(row.borrow_balance) > BigInt(0)) {
        const normal = accrued(
          BigInt(row.borrow_balance),
          BigInt(reserve.borrow_index),
          BigInt(reserve.borrow_rate),
          since,
          now,
          true
        )
        owed.set(row.asset_id, poolToBase(normal, row.asset_id, true))
      }
    }
    return {
      supplied,
      owed,
      reserves: new Map(
        data.map((r) => [
          r.id,
          {
            ltv: Number(r.ltv) / RAY_SCALE,
            liquidationThreshold: Number(r.liquidation_threshold) / RAY_SCALE,
            borrowAprPercent: Math.round((Number(r.borrow_rate) / RAY_SCALE) * 10_000) / 100,
          },
        ])
      ),
    }
  },
  standing: async (account, assetIds) => {
    const results = await simulateReads(account, (tx) => {
      for (const assetId of assetIds) priceUpdate(tx, assetId)
      const clock = tx.object(CLOCK)
      const oracle = tx.object(NAVI_PRICE_ORACLE)
      const storage = tx.object(NAVI_STORAGE)
      const user = tx.pure.address(account)
      const logic = (name: string) => moveTarget(NAVI_PACKAGE, 'logic', name)
      tx.moveCall({
        target: logic('user_health_collateral_value'),
        arguments: [clock, oracle, storage, user],
      })
      tx.moveCall({
        target: logic('user_health_loan_value'),
        arguments: [clock, oracle, storage, user],
      })
      tx.moveCall({
        target: logic('calculate_avg_ltv'),
        arguments: [clock, oracle, storage, user],
      })
      tx.moveCall({
        target: logic('dynamic_liquidation_threshold'),
        arguments: [clock, storage, oracle, user],
      })
    })
    const [collateral, loan, ltv, threshold] = results.map((b) => Number(bcs.u256().parse(b)))
    if (
      collateral === undefined ||
      loan === undefined ||
      ltv === undefined ||
      threshold === undefined
    ) {
      throw new Error("NAVI's position read returned too little.")
    }
    return {
      liquidationUsd: (collateral / USD_SCALE) * (threshold / RAY_SCALE),
      limitUsd: (collateral / USD_SCALE) * (ltv / RAY_SCALE),
      owedUsd: loan / USD_SCALE,
    }
  },
  priceUsd: async (assetId) => {
    const entry = FEED_BY_ASSET.get(assetId)
    if (entry === undefined) throw new Error(`NAVI asset ${assetId} has no pinned feed.`)
    return (await readPythObject(entry.pyth)).priceUsd
  },
  borrowFeePercent: async (account, assetId) => {
    const [fee] = await simulateReads(account, (tx) => {
      tx.moveCall({
        target: moveTarget(NAVI_PACKAGE, 'incentive_v3', 'get_borrow_fee_v2'),
        arguments: [
          tx.object(NAVI_INCENTIVE_V3),
          tx.pure.address(account),
          tx.pure.u8(assetId),
          tx.pure.u64(10_000),
        ],
      })
    })
    if (fee === undefined) throw new Error("NAVI's fee read returned nothing.")
    return Number(bcs.u64().parse(fee)) / 100
  },
  walletBalance,
}

function checkedAsset(
  request: ChainActionRequest,
  account: string
): { token: ChainToken; asset: (typeof NAVI_ASSETS)[number] } {
  assertSuiAccount(account)
  const token = tokenBySymbol(SUI_TOKENS, request.tokenIn)
  const asset = NAVI_ASSETS.find((a) => a.symbol === token?.symbol)
  if (token === undefined || asset === undefined) {
    refuse(
      `NAVI doesn't take ${request.tokenIn} here. It takes ${NAVI_ASSETS.map((a) => a.symbol).join(', ')}.`
    )
  }
  return { token, asset }
}

function heldAssets(held: NaviAccount, also: readonly number[] = []): number[] {
  return [...new Set([...held.supplied.keys(), ...held.owed.keys(), ...also])]
}

/** NAVI aborts unless every asset the person holds has a price set in the same transaction. */
function assertAllPriced(assetIds: readonly number[]): void {
  if (assetIds.some((id) => !FEED_BY_ASSET.has(id))) {
    refuse(
      'You hold an asset on NAVI I have no price feed for, so I can only do this at app.naviprotocol.io.'
    )
  }
}

function assetOf(symbol: string): (typeof NAVI_ASSETS)[number] {
  const asset = NAVI_ASSETS.find((a) => a.symbol === symbol)
  if (asset === undefined) throw new Error(`NAVI has no pool for ${symbol}.`)
  return asset
}

export function naviBorrowTransaction(
  account: string,
  symbol: string,
  amount: bigint,
  pricedAssets: readonly number[]
): Transaction {
  const asset = assetOf(symbol)
  const tx = new Transaction()
  tx.setSender(account)
  for (const assetId of new Set(pricedAssets)) priceUpdate(tx, assetId)
  tx.moveCall({
    target: ENTRY_BORROW_V2,
    typeArguments: [coinTypeOf(symbol)],
    arguments: [
      tx.object(CLOCK),
      tx.object(NAVI_PRICE_ORACLE),
      tx.object(NAVI_STORAGE),
      tx.object(asset.pool),
      tx.pure.u8(asset.assetId),
      tx.pure.u64(amount),
      tx.object(NAVI_INCENTIVE_V2),
      tx.object(NAVI_INCENTIVE_V3),
      tx.object(SUI_SYSTEM),
    ],
  })
  return tx
}

/** What's left of the coin after the debt comes back to the sender, from the contract. */
export function naviRepayTransaction(account: string, symbol: string, amount: bigint): Transaction {
  const asset = assetOf(symbol)
  const tx = new Transaction()
  tx.setSender(account)
  const coin = tx.add(
    symbol === SUI_SYMBOL
      ? coinWithBalance({ balance: amount })
      : coinWithBalance({ type: coinTypeOf(symbol), balance: amount, useGasCoin: false })
  )
  tx.moveCall({
    target: ENTRY_REPAY,
    typeArguments: [coinTypeOf(symbol)],
    arguments: [
      tx.object(CLOCK),
      tx.object(NAVI_PRICE_ORACLE),
      tx.object(NAVI_STORAGE),
      tx.object(asset.pool),
      tx.pure.u8(asset.assetId),
      coin,
      tx.pure.u64(amount),
      tx.object(NAVI_INCENTIVE_V2),
      tx.object(NAVI_INCENTIVE_V3),
    ],
  })
  return tx
}

export function naviWithdrawTransaction(
  account: string,
  symbol: string,
  amount: bigint,
  pricedAssets: readonly number[]
): Transaction {
  const asset = assetOf(symbol)
  const tx = new Transaction()
  tx.setSender(account)
  for (const assetId of new Set(pricedAssets)) priceUpdate(tx, assetId)
  const isSui = symbol === SUI_SYMBOL
  tx.moveCall({
    target: isSui ? ENTRY_WITHDRAW_V2 : ENTRY_WITHDRAW,
    typeArguments: [coinTypeOf(symbol)],
    arguments: [
      tx.object(CLOCK),
      tx.object(NAVI_PRICE_ORACLE),
      tx.object(NAVI_STORAGE),
      tx.object(asset.pool),
      tx.pure.u8(asset.assetId),
      tx.pure.u64(amount),
      tx.object(NAVI_INCENTIVE_V2),
      tx.object(NAVI_INCENTIVE_V3),
      ...(isSui ? [tx.object(SUI_SYSTEM)] : []),
    ],
  })
  return tx
}

/**
 * The contract pays the smaller of the amount and what the person holds. Interest adds to a
 * position between reading it and signing, so asking for a little more is what leaves nothing.
 */
export function wholeWithdrawAmount(held: bigint): bigint {
  return held + held / BigInt(100) + BigInt(1)
}

export async function prepareNaviWithdraw(
  request: ChainActionRequest,
  account: string,
  reader: NaviReader = naviChainReader
): Promise<PreparedAction> {
  const { token, asset } = checkedAsset(request, account)
  const amount = BigInt(toBaseUnits(request.amount, token.decimals))
  const held = await reader.account(account)
  const supplied = held.supplied.get(asset.assetId) ?? BigInt(0)
  if (supplied <= BigInt(0)) {
    refuse(`This wallet has no ${token.symbol} in NAVI.`)
  }
  const whole = request.wholePosition === true
  if (!whole && !gaveWhatWasAsked(supplied, amount)) {
    const has = displayAmount(supplied.toString(), token.decimals)
    refuse(
      `You have about ${has} ${token.symbol} in NAVI, which is less than ${request.amount}. Try ${has}.`
    )
  }
  const priced = heldAssets(held)
  assertAllPriced(priced)

  const notes = [
    'If most of the pool is lent out, this can fail until borrowers repay.',
    `NAVI needs a current price to let money out, and this reads one that others publish on chain. If that price has gone stale, this stops until it's fresh again.`,
  ]
  if (held.owed.size > 0) {
    const reserve = held.reserves.get(asset.assetId)
    if (reserve === undefined) refuse("I couldn't read this NAVI pool's rules.")
    const taken = Number(amount) / 10 ** token.decimals
    const value = taken * (await reader.priceUsd(asset.assetId))
    const health = assertWithdrawFits({
      venueName: 'NAVI',
      symbol: token.symbol,
      standing: await reader.standing(account, priced),
      removedLimitUsd: value * reserve.ltv,
      removedLiquidationUsd: value * reserve.liquidationThreshold,
      amount: taken,
    })
    if (health !== undefined) notes.push(withdrawLoanNote(token.symbol, health))
  }

  const tx = naviWithdrawTransaction(
    account,
    token.symbol,
    whole ? wholeWithdrawAmount(amount) : amount,
    priced
  )
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const received = await dryRunChange(transaction, token.id, account, 'Checking the withdrawal')
  if (received === undefined || received <= BigInt(0)) {
    refuse(
      "I couldn't confirm this withdrawal would return anything, so I stopped. Try again shortly."
    )
  }
  const receive = displayAmount(received.toString(), token.decimals)
  if (!gaveWhatWasAsked(received, amount)) {
    refuse(
      `You have about ${receive} ${token.symbol} in NAVI, which is less than ${request.amount}. Try ${receive}.`
    )
  }

  return {
    venueId: 'navi',
    venueName: 'NAVI',
    kind: 'withdraw',
    summary: `Withdraw about ${receive} ${token.symbol} from NAVI's main lending market to your wallet.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: receive, symbol: token.symbol, approximate: true },
    notes,
    signing: { family: 'sui', transaction },
  }
}

const NO_STANDING: LoanStanding = { liquidationUsd: 0, limitUsd: 0, owedUsd: 0 }

export async function prepareNaviBorrow(
  request: ChainActionRequest,
  account: string,
  reader: NaviReader = naviChainReader
): Promise<PreparedAction> {
  const { token, asset } = checkedAsset(request, account)
  const amount = BigInt(toBaseUnits(request.amount, token.decimals))
  const held = await reader.account(account)
  const priced = heldAssets(held, [asset.assetId])
  assertAllPriced(priced)

  const [standing, price, feePercent] = await Promise.all([
    held.supplied.size === 0 ? NO_STANDING : reader.standing(account, priced),
    reader.priceUsd(asset.assetId),
    reader.borrowFeePercent(account, asset.assetId),
  ])
  const debtPrice = price * (1 + feePercent / 100)
  const health = assertBorrowFits({
    venueName: 'NAVI',
    symbol: token.symbol,
    standing,
    addedOwedUsd: (Number(amount) / 10 ** token.decimals) * debtPrice,
    priceUsd: debtPrice,
  })

  const tx = naviBorrowTransaction(account, token.symbol, amount, priced)
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const received = await dryRunChange(transaction, token.id, account, 'Checking the borrow')
  if (received === undefined || !gaveWhatWasAsked(received, amount)) {
    refuse(
      "I couldn't confirm this borrow would pay what you asked, so I stopped. Try again shortly."
    )
  }

  return {
    venueId: 'navi',
    venueName: 'NAVI',
    kind: 'borrow',
    summary: `Borrow ${request.amount} ${token.symbol} from NAVI's main lending market at a variable rate.`,
    pay: { amount: request.amount, symbol: token.symbol },
    receive: { amount: request.amount, symbol: token.symbol, approximate: false },
    notes: borrowNotes({
      venueName: 'NAVI',
      symbol: token.symbol,
      health,
      borrowAprPercent: held.reserves.get(asset.assetId)?.borrowAprPercent,
      feePercent,
    }),
    signing: { family: 'sui', transaction },
  }
}

export async function prepareNaviRepay(
  request: ChainActionRequest,
  account: string,
  reader: NaviReader = naviChainReader
): Promise<PreparedAction> {
  const { token, asset } = checkedAsset(request, account)
  const asked = BigInt(toBaseUnits(request.amount, token.decimals))
  const held = await reader.account(account)
  const owed = held.owed.get(asset.assetId) ?? BigInt(0)
  if (owed <= BigInt(0)) refuse(`You don't owe any ${token.symbol} on NAVI.`)

  const coin = repayCoinAmount({
    asked,
    owed,
    whole: request.wholePosition === true,
    held: await reader.walletBalance(account, token.id),
    symbol: token.symbol,
    decimals: token.decimals,
  })
  const clearing = coin >= owed
  const tx = naviRepayTransaction(account, token.symbol, coin)
  const transaction = await buildUnsigned(tx, suiClient(), token.symbol)
  const change = await dryRunChange(transaction, token.id, account, 'Checking the repayment')
  const paid = change === undefined ? undefined : -change
  if (paid === undefined || !gaveWhatWasAsked(paid, clearing ? owed : asked)) {
    refuse("I couldn't confirm what this repayment would do, so I stopped. Try again shortly.")
  }

  const owes = displayAmount(owed.toString(), token.decimals)
  return {
    venueId: 'navi',
    venueName: 'NAVI',
    kind: 'repay',
    summary: clearing
      ? `Repay your whole ${token.symbol} loan on NAVI, about ${displayAmount(paid.toString(), token.decimals)} ${token.symbol}, interest included.`
      : `Repay ${request.amount} ${token.symbol} of your loan on NAVI.`,
    pay: { amount: displayAmount(paid.toString(), token.decimals), symbol: token.symbol },
    notes: [
      `You owe about ${owes} ${token.symbol} on NAVI, interest included.`,
      clearing
        ? 'This offers a little more than that, to cover interest added before you sign. Only what you owe is taken, and the rest stays in your wallet.'
        : 'Interest keeps adding to what is left, and a loan can still be liquidated until it is paid off.',
    ],
    signing: { family: 'sui', transaction },
  }
}

/** Only tokens this app lists are reported: nothing else can be acted on here. */
export async function readNaviPositions(
  account: string,
  reader: NaviReader = naviChainReader
): Promise<VenuePosition[]> {
  assertSuiAccount(account)
  const held = await reader.account(account)
  const positions: VenuePosition[] = []
  for (const asset of NAVI_ASSETS) {
    const decimals = DECIMALS_BY_ASSET.get(asset.assetId) ?? POOL_DECIMALS
    const supplied = held.supplied.get(asset.assetId)
    if (supplied !== undefined && supplied > BigInt(0)) {
      positions.push({
        slot: 'supplied',
        symbol: asset.symbol,
        amount: displayAmount(supplied.toString(), decimals),
      })
    }
    const owed = held.owed.get(asset.assetId)
    if (owed !== undefined && owed > BigInt(0)) {
      positions.push({
        slot: 'borrowed',
        symbol: asset.symbol,
        amount: displayAmount(owed.toString(), decimals),
      })
    }
  }
  return positions
}
