import { getAddressDecoder, getAddressEncoder, type Address } from '@solana/kit'
import { z } from 'zod'

import { venueFetch } from '../solana/http'

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

const MINT_MIN = 82
const TOKEN_ACCOUNT_MIN = 165

export interface NameAccount {
  /** The program that owns this account. */
  program: string
  data: Uint8Array
}

export interface HeldToken {
  address: string
  data: Uint8Array
}

/** A read that fails throws. An account the chain says is absent is `null`, which is not a failure. */
export interface SolanaNameRpc {
  accounts: (addresses: readonly string[]) => Promise<(NameAccount | null)[]>
  tokenAccounts: (mint: string, tokenProgram: string) => Promise<HeldToken[]>
}

const Encoded = z.tuple([z.string(), z.literal('base64')])
const Accounts = z.object({
  result: z.object({
    value: z.array(z.object({ owner: z.string(), data: Encoded }).nullable()),
  }),
})
const Held = z.object({
  result: z.array(z.object({ pubkey: z.string(), account: z.object({ data: Encoded }) })),
})

function decoded(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

async function call(method: string, params: unknown[]): Promise<unknown> {
  const url = process.env['SOLANA_RPC_URL']?.trim() || DEFAULT_RPC_URL
  const { status, body } = await venueFetch(url, {
    label: 'Solana',
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method, params },
  })
  if (status !== 200) throw new Error(`${method} answered ${status}`)
  return body
}

export function solanaNameRpc(): SolanaNameRpc {
  return {
    accounts: async (addresses) => {
      const { result } = Accounts.parse(
        await call('getMultipleAccounts', [
          addresses,
          { encoding: 'base64', commitment: 'confirmed' },
        ])
      )
      if (result.value.length !== addresses.length) throw new Error('short answer')
      return result.value.map((account) =>
        account === null ? null : { program: account.owner, data: decoded(account.data[0]) }
      )
    },
    tokenAccounts: async (mint, tokenProgram) => {
      // Not getTokenLargestAccounts, which the public endpoint answers almost only with a 429.
      const { result } = Held.parse(
        await call('getProgramAccounts', [
          tokenProgram,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            filters: [
              ...(tokenProgram === TOKEN_PROGRAM ? [{ dataSize: TOKEN_ACCOUNT_MIN }] : []),
              { memcmp: { offset: 0, bytes: mint } },
            ],
          },
        ])
      )
      return result.map(({ pubkey, account }) => ({
        address: pubkey,
        data: decoded(account.data[0]),
      }))
    },
  }
}

export function addressAt(data: Uint8Array, offset: number): string {
  return getAddressDecoder().decode(data.subarray(offset, offset + 32))
}

export function addressBytes(address: string): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(address as Address))
}

export function u64At(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true)
}

const ONE = BigInt(1)
const NONE = BigInt(0)

/**
 * The one wallet holding this one-of-one token, or nothing. The mint must be initialized, hold no
 * decimals and exactly one token, and exactly one account must hold it. Anything else has no answer.
 */
export async function soleHolder(
  rpc: SolanaNameRpc,
  mint: string,
  tokenProgram: string
): Promise<string | undefined> {
  const [mintAccount] = await rpc.accounts([mint])
  if (
    mintAccount === null ||
    mintAccount === undefined ||
    mintAccount.program !== tokenProgram ||
    mintAccount.data.length < MINT_MIN ||
    u64At(mintAccount.data, 36) !== ONE ||
    mintAccount.data[44] !== 0 ||
    mintAccount.data[45] !== 1
  ) {
    return undefined
  }
  const holding = (await rpc.tokenAccounts(mint, tokenProgram)).filter(
    ({ data }) =>
      data.length >= TOKEN_ACCOUNT_MIN && addressAt(data, 0) === mint && u64At(data, 64) !== NONE
  )
  const only = holding[0]
  if (only === undefined || holding.length !== 1) return undefined
  if (u64At(only.data, 64) !== ONE || only.data[108] === 0) return undefined
  return addressAt(only.data, 32)
}
