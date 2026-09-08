import { STELLAR_USDC } from '@intent/config'

/**
 * Resolving a token symbol to something the network understands.
 *
 * Stellar has two ways of naming the same value and they are not
 * interchangeable. Classic assets are a code plus an issuer account
 * (`USDC:GBBD47...`), while Soroban contracts address the same asset by
 * contract id (`CDLZFC3...`). A quote from Horizon speaks the first language
 * and a quote from a Soroban router speaks the second, so both live here rather
 * than being reinvented at each call site.
 */

/** A classic Stellar asset: native XLM, or an issued asset with a code and issuer. */
export interface ClassicAsset {
  kind: 'classic'
  /** 'XLM' for the native asset. */
  code: string
  /** Absent for native XLM; required for every issued asset. */
  issuer?: string
}

/** A Soroban token, addressed by contract id. */
export interface ContractAsset {
  kind: 'contract'
  code: string
  contract: string
}

export type AssetRef = ClassicAsset | ContractAsset

export function isNative(asset: AssetRef): boolean {
  return asset.kind === 'classic' && asset.issuer === undefined && asset.code === 'XLM'
}

/**
 * Stellar amounts carry seven decimal places, and the smallest unit is a
 * stroop. Every amount that crosses a network boundary is a base-unit string,
 * never a float: `0.1 + 0.2` is famously not `0.3`, and a rounding error here
 * is money.
 */
export const STROOP_DECIMALS = 7

const STROOPS_PER_UNIT = 10_000_000n

/** "30" -> "300000000" (30 XLM in stroops). Rejects anything that would lose precision. */
export function toBaseUnits(amount: string): string {
  const trimmed = amount.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`amount "${amount}" is not a positive decimal`)
  }

  const [whole = '0', fraction = ''] = trimmed.split('.')
  if (fraction.length > STROOP_DECIMALS) {
    throw new Error(`amount "${amount}" has more than ${STROOP_DECIMALS} decimal places`)
  }

  const padded = fraction.padEnd(STROOP_DECIMALS, '0')
  return (BigInt(whole) * STROOPS_PER_UNIT + BigInt(padded)).toString()
}

/** "300000000" -> "30.0000000". The inverse of `toBaseUnits`, for display. */
export function fromBaseUnits(base: string): string {
  const value = BigInt(base)
  const whole = value / STROOPS_PER_UNIT
  const fraction = (value % STROOPS_PER_UNIT).toString().padStart(STROOP_DECIMALS, '0')
  return `${whole.toString()}.${fraction}`
}

/**
 * Applies a slippage tolerance to a quoted amount, rounding **down**.
 *
 * Rounding down matters: this figure becomes `destMin` on the operation, and
 * rounding up would set a floor the quoted path cannot actually clear, failing
 * transactions that should have succeeded.
 */
export function applySlippage(baseAmount: string, toleranceBps: number): string {
  if (toleranceBps < 0 || toleranceBps > 10_000) {
    throw new Error(`slippage tolerance ${toleranceBps} bps is out of range`)
  }
  const amount = BigInt(baseAmount)
  return ((amount * BigInt(10_000 - toleranceBps)) / 10_000n).toString()
}

export const XLM: ClassicAsset = { kind: 'classic', code: 'XLM' }

export const USDC: ClassicAsset = {
  kind: 'classic',
  code: STELLAR_USDC.code,
  issuer: STELLAR_USDC.issuer,
}

/**
 * The assets a user may name in an intent.
 *
 * Deliberately a small allowlist rather than anything resolvable. An intent is
 * free text interpreted by a model, and "swap my ETH for SCAMCOIN" must fail at
 * the boundary rather than resolve to whatever issuer happens to answer.
 */
const KNOWN: Record<string, ClassicAsset> = {
  XLM: XLM,
  USDC: USDC,
}

export function resolveAsset(symbol: string): ClassicAsset | undefined {
  return KNOWN[symbol.trim().toUpperCase()]
}

export function knownSymbols(): string[] {
  return Object.keys(KNOWN)
}

/** Horizon names the native asset by type rather than by code. */
export function toHorizonParams(asset: ClassicAsset, prefix: string): Record<string, string> {
  if (isNative(asset)) return { [`${prefix}_asset_type`]: 'native' }

  if (asset.issuer === undefined) {
    throw new Error(`asset ${asset.code} needs an issuer`)
  }
  return {
    [`${prefix}_asset_type`]: asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
    [`${prefix}_asset_code`]: asset.code,
    [`${prefix}_asset_issuer`]: asset.issuer,
  }
}

/** The `CODE:ISSUER` form Horizon uses in list parameters and path hops. */
export function toCanonical(asset: ClassicAsset): string {
  return isNative(asset) ? 'native' : `${asset.code}:${asset.issuer ?? ''}`
}

/** Parses Horizon's `native` / `CODE:ISSUER` form back into an asset. */
export function fromCanonical(value: string): ClassicAsset {
  if (value === 'native') return XLM
  const [code = '', issuer = ''] = value.split(':')
  return { kind: 'classic', code, issuer }
}
