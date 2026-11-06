import { z } from 'zod'

import { bytesFromBase64 } from '../base64'
import { ChainActionRefused } from '../types'
import { TOKEN_PROGRAM } from './assert-safe'
import { readU64, type ChainAccount, type SolanaRpc } from './stake-pool'

/** The most accounts one `getMultipleAccounts` call may name. */
const BATCH = 100
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64

const Reply = z.object({
  value: z.array(
    z
      .object({
        owner: z.string(),
        lamports: z.number().int().nonnegative(),
        data: z.tuple([z.string(), z.literal('base64')]),
      })
      .nullable()
  ),
})

function unreadable(): never {
  throw new ChainActionRefused(
    'Solana’s network could not be read just now. Nothing was signed or sent, so try again in a moment.'
  )
}

/**
 * Several accounts at once. Unlike `readAccount`, an account that doesn't exist comes back as
 * nothing, because for a position that is an answer: this person holds none.
 */
export async function readAccounts(
  rpc: SolanaRpc,
  addresses: readonly string[]
): Promise<(ChainAccount | null)[]> {
  const read: (ChainAccount | null)[] = []
  for (let at = 0; at < addresses.length; at += BATCH) {
    const batch = addresses.slice(at, at + BATCH)
    const reply = Reply.safeParse(
      await rpc('getMultipleAccounts', [batch, { encoding: 'base64', commitment: 'confirmed' }])
    )
    if (!reply.success || reply.data.value.length !== batch.length) return unreadable()
    for (const account of reply.data.value) {
      read.push(
        account === null
          ? null
          : {
              owner: account.owner,
              lamports: BigInt(account.lamports),
              data: bytesFromBase64(account.data[0]),
            }
      )
    }
  }
  return read
}

/** What a token account holds, in base units. An account that doesn't exist holds nothing. */
export function tokenAccountAmount(account: ChainAccount | null): bigint {
  if (account === null) return BigInt(0)
  if (account.owner !== TOKEN_PROGRAM || account.data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) {
    return unreadable()
  }
  return readU64(account.data, TOKEN_ACCOUNT_AMOUNT_OFFSET)
}
