import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Address,
} from '@solana/kit'

/**
 * Lighthouse, the assertion program Phantom adds "guard instructions" from when it signs: each one
 * checks an account against what the wallet previewed, and fails the whole transaction if it
 * differs. https://phantom.com/learn/blog/anti-spoofing-security. Executable on mainnet on
 * 6 November 2026, an upgradeable program, so trusting it means trusting its upgrade authority.
 */
export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'

/**
 * The signed transaction as a venue's check should see it: the same bytes, without the guard
 * instructions a wallet added after this app built it. Only for checking. What is sent is what the
 * wallet signed, guards and all.
 *
 * Anything else a wallet or page adds still reaches the check and is refused there. A transaction
 * that cannot be read, or carries bytes past its message, is returned as it came, so the check
 * refuses it for that.
 */
export function withoutWalletGuards(base64: string): string {
  try {
    const transaction = getTransactionDecoder().decode(Buffer.from(base64, 'base64'))
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
    const encoded = getCompiledTransactionMessageEncoder().encode(message)
    const exact =
      encoded.length === transaction.messageBytes.length &&
      encoded.every((byte, i) => byte === transaction.messageBytes[i])
    if (!exact) return base64

    const guard = message.staticAccounts.indexOf(LIGHTHOUSE_PROGRAM as Address)
    if (guard === -1) return base64
    const instructions = message.instructions.filter((ix) => ix.programAddressIndex !== guard)
    if (instructions.length === message.instructions.length) return base64

    const messageBytes = getCompiledTransactionMessageEncoder().encode({ ...message, instructions })
    const unguarded = getTransactionEncoder().encode({
      messageBytes,
      signatures: transaction.signatures,
    } as Parameters<ReturnType<typeof getTransactionEncoder>['encode']>[0])
    return Buffer.from(unguarded).toString('base64')
  } catch {
    return base64
  }
}
