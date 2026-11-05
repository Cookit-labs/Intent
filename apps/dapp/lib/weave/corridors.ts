import { CASHOUT_CHAINS, type CashoutChain } from './types'

export type CashoutCurrency = 'NGN' | 'KES' | 'UGX' | 'TZS'

export interface Corridor {
  code: CashoutCurrency
  name: string
  country: string
  symbol: string
}

export const CORRIDORS: Readonly<Record<CashoutCurrency, Corridor>> = {
  NGN: { code: 'NGN', name: 'Nigerian naira', country: 'Nigeria', symbol: '₦' },
  KES: { code: 'KES', name: 'Kenyan shilling', country: 'Kenya', symbol: 'KSh' },
  UGX: { code: 'UGX', name: 'Ugandan shilling', country: 'Uganda', symbol: 'USh' },
  TZS: { code: 'TZS', name: 'Tanzanian shilling', country: 'Tanzania', symbol: 'TSh' },
}

export function isCashoutCurrency(value: string): value is CashoutCurrency {
  return Object.prototype.hasOwnProperty.call(CORRIDORS, value)
}

type Env = Record<string, string | undefined>

/**
 * The currencies a payout can go to right now. Naira only unless the deployment
 * says otherwise, because no real payout has been tested for the others. A list
 * that names nothing known opens nothing: someone set it on purpose, and falling
 * back would pay out where they did not ask.
 */
export function liveCurrencies(env: Env = process.env): CashoutCurrency[] {
  const raw = env['WEAVE_CASHOUT_CURRENCIES']?.trim()
  if (raw === undefined || raw === '') return ['NGN']
  const named = raw.split(',').map((entry) => entry.trim().toUpperCase())
  return (Object.keys(CORRIDORS) as CashoutCurrency[]).filter((code) => named.includes(code))
}

/**
 * What the model is told about cash-outs on a chain. Written from what this
 * deployment can actually pay, so it never offers what would then be refused.
 */
export function cashOutPrompt(chain: string, env: Env = process.env): string {
  const onWeave = (env['WEAVE_SECRET_KEY'] ?? '').trim() !== ''
  const weave = onWeave ? liveCurrencies(env) : []
  const stellar = chain === 'stellar'
  if (!stellar && !isCashoutChainName(chain)) return ''

  const codes = stellar ? ['NGN' as const, ...weave.filter((code) => code !== 'NGN')] : weave
  if (codes.length === 0) return ''
  if (stellar && codes.length === 1) {
    return [
      'Cashing out to a bank is possible only to Nigerian naira (NGN), from XLM or USDC. If the user says off-ramp or cash out',
      'without an asset, ask which asset they are cashing out and say the payout is to naira.',
      'If they ask for another currency, ask whether they want naira instead.',
    ].join(' ')
  }
  const list = codes.map((code) => `${CORRIDORS[code].name} (${code})`).join(', ')
  return [
    `Cashing out pays to a bank or mobile money account, in one of these: ${list}.`,
    'Never assume a currency or a country. If the user says off-ramp or cash out without naming a currency,',
    'ask which currency they want and list these. If they named one of them, do not ask again.',
    'If they ask for another currency, say it is not available and list these.',
    stellar ? 'The asset is USDC, or XLM when the payout is in naira.' : 'The asset is USDC.',
  ].join(' ')
}

function isCashoutChainName(chain: string): boolean {
  return (CASHOUT_CHAINS as readonly string[]).includes(chain)
}

/** Stellar naira stays on the existing Linq flow, so it is never offered here. */
export function isCurrencyAllowed(
  chain: CashoutChain,
  currency: string,
  env: Env = process.env
): currency is CashoutCurrency {
  if (!isCashoutCurrency(currency)) return false
  if (chain === 'stellar' && currency === 'NGN') return false
  return liveCurrencies(env).includes(currency)
}
