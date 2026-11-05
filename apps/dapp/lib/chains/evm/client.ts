import {
  createPublicClient,
  erc20Abi,
  http,
  type Address,
  type Hash,
  type TransactionReceipt,
  type Transport,
} from 'viem'

import { EVM_CHAINS, type EvmChain } from './tokens'

const RPC_TIMEOUT_MS = 8_000
/** Well inside the submit route's 60 seconds, which still has 1Click to wait on afterwards. */
const RECEIPT_TIMEOUT_MS = 20_000

export type EvmReceipt = Pick<TransactionReceipt, 'status' | 'from' | 'to' | 'logs'>

export interface EvmTransaction {
  value: bigint
  input: string
}

export interface EvmClient {
  tokenBalance: (token: Address, account: Address) => Promise<bigint>
  allowance: (token: Address, owner: Address, spender: Address) => Promise<bigint>
  nativeBalance: (account: Address) => Promise<bigint>
  waitForReceipt: (hash: Hash) => Promise<EvmReceipt>
  /** A receipt doesn't carry what a transaction paid or called, so these are read apart from it. */
  transaction: (hash: Hash) => Promise<EvmTransaction>
}

/** Reads this chain only, so a hash from another chain isn't found here. */
export function evmClient(chain: EvmChain, transport?: Transport): EvmClient {
  const { chain: viemChain, rpcEnv } = EVM_CHAINS[chain]
  const client = createPublicClient({
    chain: viemChain,
    transport:
      transport ??
      http(process.env[rpcEnv]?.trim() || undefined, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
  })
  return {
    tokenBalance: (token, account) =>
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account],
      }),
    allowance: (token, owner, spender) =>
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, spender],
      }),
    nativeBalance: (address) => client.getBalance({ address }),
    waitForReceipt: (hash) =>
      client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }),
    transaction: async (hash) => {
      const { value, input } = await client.getTransaction({ hash })
      return { value, input }
    },
  }
}
