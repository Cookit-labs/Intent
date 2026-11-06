import { bcs } from '@mysten/sui/bcs'
import { createPublicClient, http, parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  ANS_MONAD_REGISTRY,
  ANS_MONAD_RESOLVER,
  ANS_MONAD_ROOT,
} from '../chains/names/alldomains-monad'
import { ansAccounts } from '../chains/names/alldomains-solana'
import { resolveName } from '../chains/names/resolve'
import { snsAccounts, solAccounts } from '../chains/names/sns'
import {
  addressAt,
  soleHolder,
  solanaNameRpc,
  TOKEN_2022_PROGRAM,
} from '../chains/names/solana-rpc'
import { SUINS_REGISTRY_TABLE } from '../chains/names/suins'
import { NAME_TLDS, recipientName } from '../chains/names/tlds'
import { suiClient } from '../chains/sui/client'
import { ChainActionRefused, type ChainWithActions } from '../chains/types'

/**
 * Read-only: that the ids pinned for names still hold on chain, and that real names read as the
 * resolver says. Signs nothing and sends nothing. Solana's public endpoint rate-limits hard, so
 * these run one after another with a pause, and a name that changes hands fails its test, which
 * says to look rather than that the code is wrong.
 */

const SKIP = process.env['SKIP_LIVE'] === '1'
const SLOW_MS = 90_000
const SOLANA_URL = process.env['SOLANA_RPC_URL']?.trim() || 'https://api.mainnet-beta.solana.com'
const MONAD_URL = 'https://rpc.monad.xyz'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function reads(chain: ChainWithActions, text: string): Promise<string> {
  await wait(1_500)
  const typed = recipientName(text)
  if (typed === undefined) throw new Error(`${text} is not a name`)
  return (await resolveName(chain, typed)).address
}

async function refusal(chain: ChainWithActions, text: string): Promise<string> {
  try {
    await reads(chain, text)
  } catch (e) {
    if (e instanceof ChainActionRefused) return e.message
    throw e
  }
  throw new Error(`${text} read without a refusal`)
}

async function account(address: string): Promise<{ owner: string; executable: boolean } | null> {
  await wait(1_500)
  const reply = await fetch(SOLANA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [address, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }],
    }),
  })
  const body = (await reply.json()) as {
    result: { value: { owner: string; executable: boolean } | null }
  }
  return body.result.value
}

describe.skipIf(SKIP).sequential('names on chain', () => {
  it(
    "SNS and .sol programs are still programs, and the root is the name program's",
    async () => {
      const programs = [
        'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX',
        'nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk',
        'srsWjm76StJucL7atFyPSdXFaVLNPFqEt1uFEDPrZsn',
        'ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK',
        'NH3uX6FtVE2fNREAioP7hm5RaozotZxeL6khU1EHx51',
      ]
      for (const program of programs) {
        expect((await account(program))?.executable).toBe(true)
      }
      expect((await account('58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx'))?.owner).toBe(
        'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX'
      )
    },
    SLOW_MS
  )

  it(
    'a .sol name both registries agree on reads to that wallet, and .sns to the same',
    async () => {
      const { record } = await solAccounts('toly')
      const { domain } = await snsAccounts('toly')
      const [srs, sns] = await solanaNameRpc().accounts([record, domain])
      expect(srs).not.toBeNull()
      expect(sns).not.toBeNull()
      const owner = addressAt(sns?.data as Uint8Array, 32)
      expect(addressAt(srs?.data as Uint8Array, 34)).toBe(owner)
      expect(await reads('solana', 'toly.sol')).toBe(owner)
      expect(await reads('solana', 'toly.sns')).toBe(owner)
    },
    SLOW_MS
  )

  it(
    'a .sol name the registries disagree on is refused, with both wallets named',
    async () => {
      const words = await refusal('solana', 'mert.sol')
      expect(words).toContain('two different wallets')
      expect(words).toContain('Nothing was signed or sent.')
    },
    SLOW_MS
  )

  it(
    'V2 and V1 records as they really are on chain',
    async () => {
      expect(await reads('solana', 'pumpfunian.sns')).toBe(
        '25XoARksNA8wGUpTpqeczHc3yhkJgE2sCjHRvqqLi4Bb'
      )
      expect(await reads('solana', 'erizzo.sns')).toBe(
        'GRQfjSEYfYEjnWbU7S8fzSmjWcex5Gn6XyfxbXdRmUVm'
      )
    },
    SLOW_MS
  )

  it(
    'a tokenized name reads to one holder, and a holder that is a program is refused',
    async () => {
      const { nft } = await snsAccounts('chiba')
      expect((await account(nft))?.owner).toBe('nftD3vbNkNqfj2Sd3HZwbpw4BxxKWr4AjGb9X38JeZk')
      expect(await refusal('solana', 'chiba.sns')).toContain('held by a program')
      // chiba is listed for sale, so Magic Eden's escrow holds it, as most sampled tokenized names were.
      expect(await reads('solana', 'robansk2025.sns')).toBe(
        'BZxiMxyWkx9vLkidkMBGbph47vxEYxhe9we9g7mc93bH'
      )
    },
    SLOW_MS
  )

  it(
    'a tokenized .sol record has one Token-2022 holder at its canonical mint',
    async () => {
      await wait(1_500)
      expect(
        await soleHolder(
          solanaNameRpc(),
          '22egh7pqeQZ9gCm5wfB5g6EGBgRwqdzPDS2p1oy7BMte',
          TOKEN_2022_PROGRAM
        )
      ).toBe('2q7yVFkqX1RfcEPBV94Wmw2QntXPVsAR8tqT5cw65npp')
    },
    SLOW_MS
  )

  it(
    'an unregistered name is refused',
    async () => {
      const words = await refusal('solana', 'no-such-name-here-20261105.sns')
      expect(words).toContain("isn't registered")
    },
    SLOW_MS
  )

  it(
    'AllDomains on Solana: the origin derives, and a known name reads',
    async () => {
      const { parent } = await ansAccounts('miester', 'poor')
      expect(parent).toBe('8err4ThuTiZo9LbozHAvMrzXUmyPWj9urnMo38vC6FdQ')
      expect(await reads('solana', 'miester.poor')).toBe(
        '2EGGxj2qbNAJNgLCPKca8sxZYetyTjnoRspTPjzN2D67'
      )
    },
    SLOW_MS
  )

  it(
    'AllDomains on Monad: contracts hold code, the root names its registry and every ending',
    async () => {
      const client = createPublicClient({ transport: http(MONAD_URL, { timeout: 15_000 }) })
      for (const address of [ANS_MONAD_ROOT, ANS_MONAD_REGISTRY, ANS_MONAD_RESOLVER]) {
        expect(((await client.getCode({ address })) ?? '0x').length).toBeGreaterThan(2)
      }
      const root = parseAbi([
        'function registry() view returns (address)',
        'struct T { address a; address b; string tld; string d; string e; bool f; bytes32 g; bytes32 h; }',
        'function listTlds() view returns (T[])',
      ])
      expect(
        await client.readContract({ address: ANS_MONAD_ROOT, abi: root, functionName: 'registry' })
      ).toBe(ANS_MONAD_REGISTRY)
      const tlds = await client.readContract({
        address: ANS_MONAD_ROOT,
        abi: root,
        functionName: 'listTlds',
      })
      expect(tlds.map((t) => t.tld.slice(1)).sort()).toEqual([...NAME_TLDS.monad].sort())
      expect(await reads('monad', 'miester.mon')).toBe('0x94Bfb92da83B27B39370550CA038Af96d182462f')
    },
    SLOW_MS
  )

  it(
    'SuiNS: the registry table is the one the SuiNS object holds, and names read',
    async () => {
      const V1 = '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0'
      const SUINS = '0x6e0ddefc0ad98889c04bab9639e512c21766c5e6366f89e696956d9be6952871'
      const { dynamicField } = await suiClient().core.getDynamicField({
        parentId: SUINS,
        name: {
          type: `${V1}::suins::RegistryKey<${V1}::registry::Registry>`,
          bcs: bcs.bool().serialize(false).toBytes(),
        },
      })
      expect(dynamicField.value.type).toBe(`${V1}::registry::Registry`)
      const table = `0x${Buffer.from(dynamicField.value.bcs.subarray(0, 32)).toString('hex')}`
      expect(table).toBe(SUINS_REGISTRY_TABLE)
      expect(await reads('sui', 'adeniyi.sui')).toBe(
        '0x1eb7c57e3f2bd0fc6cb9dcffd143ea957e4d98f805c358733f76dee0667fe0b1'
      )
      expect(await refusal('sui', 'ada.sui')).toContain('no address set')
      expect(await refusal('sui', 'no-such-name-here-20261105.sui')).toContain("isn't registered")
    },
    SLOW_MS
  )
})
