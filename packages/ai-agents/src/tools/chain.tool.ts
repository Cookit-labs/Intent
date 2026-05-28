import type Anthropic from '@anthropic-ai/sdk'

export const chainTool: Anthropic.Tool = {
  name: 'read_chain_state',
  description: 'Read on-chain state (balances, allowances, contract data)',
  input_schema: {
    type: 'object',
    properties: {
      contractAddress: { type: 'string' },
      method: { type: 'string', description: 'Contract method to call' },
      args: { type: 'array', items: { type: 'string' }, description: 'Method arguments' },
    },
    required: ['contractAddress', 'method'],
  },
}

export async function executeChainTool(input: {
  contractAddress: string
  method: string
  args?: string[]
}): Promise<{ result: unknown }> {
  // TODO: implement via viem/ethers
  console.warn(`[chain] calling ${input.method} on ${input.contractAddress}`)
  return { result: null }
}