import type { PinStatus } from '../names/address-book'
import type { ResolvedRecipient } from '../names/resolve'

/**
 * The sentences on the send card and in history.
 *
 * Pure text, kept out of the components so it can be pinned: the step label
 * before a payment runs, the label after it settled — which is what history
 * shows — where a name was resolved, and what the address book has to say.
 */

/** `125.0000000` as a person reads it: `125`. The seven places are the ledger's, not the amount's. */
export function plainAmount(amount: string): string {
  return amount.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
}

export function sendStepLabel(
  amount: string | undefined,
  asset: string,
  recipient: string
): string {
  if (amount === undefined) return `Send the ${asset} you receive to ${recipient}`
  return `Send ${plainAmount(amount)} ${asset} to ${recipient}`
}

export function sentLabel(amount: string, asset: string, recipient: string): string {
  return `Sent ${plainAmount(amount)} ${asset} to ${recipient}`
}

/** Where the answer came from, or nothing for a raw address that nobody answered. */
export function resolvedOnLabel(
  resolved: Pick<ResolvedRecipient, 'kind'> &
    Partial<Pick<ResolvedRecipient, 'input' | 'resolvedOn'>>
): string | undefined {
  if (resolved.kind === 'soroban-domain') return 'Name resolved on Stellar mainnet'
  if (resolved.kind === 'federation') {
    const domain = resolved.input?.split('*')[1]
    return `Resolved via federation at ${domain ?? 'the domain'}`
  }
  return undefined
}

export function pinStatusLine(pin: PinStatus): string {
  switch (pin.status) {
    case 'new':
      return 'First payment to this name. Check the address.'
    case 'known':
      return 'Same address as last time.'
    case 'changed':
      return `When you last paid this name (${pin.pinnedAt.slice(0, 10)}) it pointed at ${pin.previous}. It points somewhere new now.`
  }
}
