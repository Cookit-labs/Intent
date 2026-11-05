import { describe, expect, it } from 'vitest'

import { associatedTokenAccount, TOKEN_PROGRAM } from '../chains/solana/assert-safe'
import { createJitoVenue, JITOSOL_MINT } from '../chains/solana/jito'
import { createMarinadeVenue, MSOL_MINT } from '../chains/solana/marinade'
import { createSolayerVenue, SSOL_MINT } from '../chains/solana/solayer'
import type { SolanaRpc } from '../chains/solana/stake-pool'
import type { ChainVenue } from '../chains/types'
import {
  addressBytes,
  fakeRpc,
  ME,
  SOMEONE_ELSE,
  u64Bytes,
  type FakeAccount,
} from './solana-stake-fixtures'

function tokenAccount(mint: string, owner: string, amount: bigint): FakeAccount {
  return {
    owner: TOKEN_PROGRAM,
    lamports: BigInt(2_039_280),
    data: Uint8Array.from([
      ...addressBytes(mint),
      ...addressBytes(owner),
      ...u64Bytes(amount),
      ...new Array<number>(93).fill(0),
    ]),
  }
}

const VENUES: [string, string, string, (rpc: SolanaRpc) => ChainVenue][] = [
  ['Jito', 'JitoSOL', JITOSOL_MINT, (rpc) => createJitoVenue({ rpc })],
  ['Marinade', 'mSOL', MSOL_MINT, (rpc) => createMarinadeVenue({ rpc })],
  ['Solayer', 'sSOL', SSOL_MINT, (rpc) => createSolayerVenue({ rpc })],
]

describe.each(VENUES)('%s positions', (_name, symbol, mint, build) => {
  const own = associatedTokenAccount(ME, mint)
  const over = (account?: FakeAccount, unreadable?: string[]): ChainVenue =>
    build(
      fakeRpc({
        epoch: 1077,
        accounts: account === undefined ? {} : { [own]: account },
        ...(unreadable === undefined ? {} : { unreadable }),
      })
    )

  it('counts the staking token in the wallet as staked, to the last unit', async () => {
    await expect(
      over(tokenAccount(mint, ME, BigInt('151268371658'))).positions?.(ME)
    ).resolves.toEqual([{ slot: 'staked', symbol, amount: '151.268371658' }])
  })

  it('shows nothing with no token account, or an empty one', async () => {
    await expect(over().positions?.(ME)).resolves.toEqual([])
    await expect(over(tokenAccount(mint, ME, BigInt(0))).positions?.(ME)).resolves.toEqual([])
  })

  it('throws rather than show nothing when the chain can’t be read', async () => {
    await expect(over(undefined, ['getMultipleAccounts']).positions?.(ME)).rejects.toThrow()
  })

  it('throws on an account that isn’t this wallet’s token account', async () => {
    await expect(
      over(tokenAccount(mint, SOMEONE_ELSE, BigInt(1))).positions?.(ME)
    ).rejects.toThrow()
    await expect(over(tokenAccount(SOMEONE_ELSE, ME, BigInt(1))).positions?.(ME)).rejects.toThrow()
    await expect(
      over({ ...tokenAccount(mint, ME, BigInt(1)), owner: SOMEONE_ELSE }).positions?.(ME)
    ).rejects.toThrow()
  })

  it('throws on a wallet that isn’t an address', async () => {
    await expect(over().positions?.('0x1234')).rejects.toThrow(/Solana wallet/)
  })
})
