import type { AgentProposal, Intent } from '@intent/types'

import { BaseAIAgent } from '../core/base-agent'
import { momentumSystemPrompt, buildMomentumUserPrompt } from '../prompts/momentum.prompt'

export class MomentumAgent extends BaseAIAgent {
  readonly id = 'momentum-agent-v1'
  readonly name = 'Momentum Agent'
  readonly strategyType = 'momentum'

  async propose(intent: Intent, competitionId: string): Promise<AgentProposal> {
    const userMessage = buildMomentumUserPrompt(intent)
    const response = await this.callClaude(momentumSystemPrompt, userMessage)
    const content = response.content[0]
    const reasoning = content.type === 'text' ? content.text : ''

    // TODO: parse reasoning into structured slippage/amount projections
    return {
      id: crypto.randomUUID(),
      competitionId,
      agentId: this.id,
      projectedAmountOut: intent.minAmountOut,
      projectedSlippage: 0.1,
      qualityScore: 0,
      totalScore: 0,
      submittedAt: new Date().toISOString(),
      // @ts-expect-error reasoning is not in the type yet
      reasoning,
    }
  }
}