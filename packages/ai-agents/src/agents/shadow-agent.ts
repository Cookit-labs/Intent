import type { AgentProposal, Intent } from '@intent/types'

import { BaseAIAgent } from '../core/base-agent'
import { shadowSystemPrompt, buildShadowUserPrompt } from '../prompts/shadow.prompt'

export class ShadowAgent extends BaseAIAgent {
  readonly id = 'shadow-agent-v1'
  readonly name = 'Shadow Execution Agent'
  readonly strategyType = 'shadow'

  async propose(intent: Intent, competitionId: string): Promise<AgentProposal> {
    const userMessage = buildShadowUserPrompt(intent)
    const response = await this.callClaude(shadowSystemPrompt, userMessage)
    const content = response.content[0]
    const reasoning = content.type === 'text' ? content.text : ''

    // TODO: shadow agent runs simulation paths and picks the best outcome
    return {
      id: crypto.randomUUID(),
      competitionId,
      agentId: this.id,
      projectedAmountOut: intent.minAmountOut,
      projectedSlippage: 0.08,
      qualityScore: 0,
      totalScore: 0,
      submittedAt: new Date().toISOString(),
      // @ts-expect-error reasoning is not in the type yet
      reasoning,
    }
  }
}