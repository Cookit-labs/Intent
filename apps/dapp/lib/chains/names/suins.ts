import { bcs } from '@mysten/sui/bcs'

import { suiClient, withTimeout } from '../sui/client'
import { EXPIRED, nameRefused, NOT_CONFIRMED, NOT_REGISTERED } from './tlds'

/**
 * `packageIdV1` and `registryTableId` are `mainPackage.mainnet` in @mysten/suins 2.0.19. On chain
 * 2026-11-05: the package is immutable, and the SuiNS object's `RegistryKey<Registry>` field holds a
 * registry whose table is this id.
 */
const SUINS_PACKAGE_V1 = '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0'
export const SUINS_REGISTRY_TABLE =
  '0xe64cd9db9f829c6cc405d9790bd71567ae07259855f4fba6f02c84f52298c106'
export const SUINS_NAME_RECORD_TYPE = `${SUINS_PACKAGE_V1}::name_record::NameRecord`

const READ_MS = 8_000

const Domain = bcs.struct('Domain', { labels: bcs.vector(bcs.string()) })
export const NameRecord = bcs.struct('NameRecord', {
  nft_id: bcs.Address,
  expiration_timestamp_ms: bcs.u64(),
  target_address: bcs.option(bcs.Address),
  data: bcs.struct('VecMap', {
    contents: bcs.vector(bcs.struct('Entry', { key: bcs.string(), value: bcs.string() })),
  }),
})

export interface SuiNameReader {
  /** The value stored for these labels, ending first, or nothing if the chain has none. */
  nameRecord: (labels: readonly string[]) => Promise<{ value: Uint8Array; type: string } | null>
}

export function suiNameReader(): SuiNameReader {
  return {
    nameRecord: async (labels) => {
      try {
        const { dynamicField } = await withTimeout(
          suiClient().core.getDynamicField({
            parentId: SUINS_REGISTRY_TABLE,
            name: {
              type: `${SUINS_PACKAGE_V1}::domain::Domain`,
              bcs: Domain.serialize({ labels: [...labels] }).toBytes(),
            },
          }),
          READ_MS,
          'SuiNS read'
        )
        return { value: dynamicField.value.bcs, type: dynamicField.value.type }
      } catch (e) {
        // The node answers a missing field with an error, not an empty result.
        if (e instanceof Error && /not found/i.test(e.message)) return null
        throw e
      }
    },
  }
}

/** The address a SuiNS name targets, as `SuinsClient.getNameRecord` reads it, over the chain's RPC. */
export async function resolveSuiName(
  reader: SuiNameReader,
  name: string,
  label: string
): Promise<string> {
  const stored = await reader.nameRecord(['sui', label])
  if (stored === null) throw nameRefused(name, NOT_REGISTERED)
  if (stored.type !== SUINS_NAME_RECORD_TYPE) throw nameRefused(name, NOT_CONFIRMED)
  const record = NameRecord.parse(stored.value)
  if (BigInt(record.expiration_timestamp_ms) <= BigInt(Date.now())) {
    throw nameRefused(name, EXPIRED)
  }
  if (record.target_address === null || record.target_address === undefined) {
    throw nameRefused(name, 'has no address set, so there is nowhere to send.')
  }
  return record.target_address
}
