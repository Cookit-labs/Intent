import type { ChainSlug } from '@intent/types'
import { formatUnits } from 'viem'

type ReadableChain = Extract<ChainSlug, 'solana' | 'sui' | 'near'>

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Balance read failed (${res.status})`)
  return res.json()
}

interface JsonRpcResult<T> {
  result?: T
}

/** Lamports, from a public RPC that allows browser calls. */
async function solanaRaw(address: string): Promise<string> {
  const body = (await post('https://solana-rpc.publicnode.com', {
    jsonrpc: '2.0',
    id: 1,
    method: 'getBalance',
    params: [address],
  })) as JsonRpcResult<{ value: number }>
  if (body.result === undefined) throw new Error('No balance returned')
  return String(body.result.value)
}

/** MIST, from Sui's GraphQL service: public fullnodes no longer answer JSON-RPC. */
async function suiRaw(address: string): Promise<string> {
  const body = (await post('https://graphql.mainnet.sui.io/graphql', {
    query:
      'query($a:SuiAddress!){address(address:$a){balance(coinType:"0x2::sui::SUI"){totalBalance}}}',
    variables: { a: address },
  })) as { data?: { address?: { balance?: { totalBalance?: string } | null } | null } }
  return body.data?.address?.balance?.totalBalance ?? '0'
}

/** yoctoNEAR. An account that does not exist yet comes back as an error, which is a balance of zero. */
async function nearRaw(address: string): Promise<string> {
  const body = (await post('https://free.rpc.fastnear.com', {
    jsonrpc: '2.0',
    id: '1',
    method: 'query',
    params: { request_type: 'view_account', finality: 'final', account_id: address },
  })) as JsonRpcResult<{ amount: string }>
  return body.result?.amount ?? '0'
}

const READERS: Record<ReadableChain, (address: string) => Promise<string>> = {
  solana: solanaRaw,
  sui: suiRaw,
  near: nearRaw,
}

/** The chain's native balance as a decimal string. */
export async function fetchNativeBalance(
  chain: ReadableChain,
  address: string,
  decimals: number
): Promise<string> {
  return formatUnits(BigInt(await READERS[chain](address)), decimals)
}
