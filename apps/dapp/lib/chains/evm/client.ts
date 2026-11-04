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

export interface EvmClient {
  tokenBalance: (token: Address, account: Address) => Promise<bigint>
  nativeBalance: (account: Address) => Promise<bigint>
  waitForReceipt: (hash: Hash) => Promise<EvmReceipt>
  /** A receipt doesn't carry what a transaction paid, so this is read apart from it. */
  transactionValue: (hash: Hash) => Promise<bigint>
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
    nativeBalance: (address) => client.getBalance({ address }),
    waitForReceipt: (hash) =>
      client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }),
    transactionValue: async (hash) => (await client.getTransaction({ hash })).value,
  }
}
