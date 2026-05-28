import type Anthropic from '@anthropic-ai/sdk'

export const historyTool: Anthropic.Tool = {
  name: 'get_agent_history',
  description: "Fetch an agent's historical execution performance",
  input_schema: {
    type: 'object',
    properties: {
      agentId: { type: 'string' },
      limit: { type: 'number', description: 'Number of past executions to fetch', default: 10 },
    },
    required: ['agentId'],
  },
}

export async function executeHistoryTool(input: {
  agentId: string
  limit?: number
}): Promise<{ winRate: number; avgSlippage: number; totalExecutions: number }> {
  // TODO: fetch from backend API or database
  console.warn(`[history] fetching for agent ${input.agentId}`)
  return { winRate: 0, avgSlippage: 0, totalExecutions: 0 }
}