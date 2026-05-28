import type { AgentProposal, Intent } from '@intent/types'

import { BaseAIAgent } from '../core/base-agent'
import { twapSystemPrompt, buildTwapUserPrompt } from '../prompts/twap.prompt'

export class TWAPAgent extends BaseAIAgent {
  readonly id = 'twap-agent-v1'
  readonly name = 'TWAP Agent'
  readonly strategyType = 'twap'

  async propose(intent: Intent, competitionId: string): Promise<AgentProposal> {
    const userMessage = buildTwapUserPrompt(intent)

    const response = await this.callClaude(twapSystemPrompt, userMessage)

    // TODO: parse Claude's response into a structured proposal
    const content = response.content[0]
    const reasoning = content.type === 'text' ? content.text : ''

    // Placeholder proposal — replace with real parsing
    return {
      id: crypto.randomUUID(),
      competitionId,
      agentId: this.id,
      projectedAmountOut: intent.minAmountOut,
      projectedSlippage: 0.15,
      qualityScore: 0,
      totalScore: 0,
      submittedAt: new Date().toISOString(),
      // @ts-expect-error reasoning is not in the type yet
      reasoning,
    }
  }
}