import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  type Address,
} from '@solana/kit'

type Message = ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>

/**
 * What a wallet does when it adds an instruction before signing: the program goes on the end of
 * the read-only accounts, lookup indices after it shift up by one, and the instruction is appended.
 */
export function guarded(base64: string, program: string, data: number[] = [5]): string {
  const { messageBytes } = getTransactionDecoder().decode(Buffer.from(base64, 'base64'))
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes) as Message
  if (message.version !== 'legacy' && message.version !== 0) throw new Error('not a v0 capture')
  const old = message.staticAccounts.length
  const shift = (i: number): number => (i >= old ? i + 1 : i)
  const next = {
    ...message,
    header: {
      ...message.header,
      numReadonlyNonSignerAccounts: message.header.numReadonlyNonSignerAccounts + 1,
    },
    staticAccounts: [...message.staticAccounts, program as Address],
    instructions: [
      ...message.instructions.map((ix) => ({
        ...ix,
        programAddressIndex: shift(ix.programAddressIndex),
        accountIndices: (ix.accountIndices ?? []).map(shift),
      })),
      { programAddressIndex: old, accountIndices: [0], data: new Uint8Array(data) },
    ],
  }
  const bytes = getCompiledTransactionMessageEncoder().encode(next as Message)
  const signers = message.header.numSignerAccounts
  return Buffer.concat([
    Buffer.from([signers]),
    Buffer.alloc(64 * signers),
    Buffer.from(bytes),
  ]).toString('base64')
}
