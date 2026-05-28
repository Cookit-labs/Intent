import type Anthropic from '@anthropic-ai/sdk'

export const priceFeedTool: Anthropic.Tool = {
  name: 'get_price',
  description: 'Get the current price of a token pair',
  input_schema: {
    type: 'object',
    properties: {
      tokenIn: { type: 'string', description: 'Input token address or symbol' },
      tokenOut: { type: 'string', description: 'Output token address or symbol' },
    },
    required: ['tokenIn', 'tokenOut'],
  },
}

export async function executePriceFeedTool(input: {
  tokenIn: string
  tokenOut: string
}): Promise<{ price: number; source: string }> {
  // TODO: implement real price feed (e.g., Chainlink, Pyth, or DEX oracle)
  console.warn(`[price-feed] fetching price for ${input.tokenIn}/${input.tokenOut}`)
  return { price: 0, source: 'mock' }
}