import type { AgentProposal, Intent } from '@intent/types'

import { BaseAIAgent } from '../core/base-agent'

export class ArbAgent extends BaseAIAgent {
  readonly id = 'arb-agent-v1'
  readonly name = 'Arbitrage Agent'
  readonly strategyType = 'arbitrage'

  async propose(intent: Intent, competitionId: string): Promise<AgentProposal> {
    // TODO: implement arbitrage detection via Claude + DEX price feeds
    return {
      id: crypto.randomUUID(),
      competitionId,
      agentId: this.id,
      projectedAmountOut: intent.minAmountOut,
      projectedSlippage: 0.05,
      qualityScore: 0,
      totalScore: 0,
      submittedAt: new Date().toISOString(),
    }
  }
}