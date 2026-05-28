import Anthropic from '@anthropic-ai/sdk'
import type { AgentProposal, Intent } from '@intent/types'

import { buildScoringUserPrompt, scoringSystemPrompt } from '../prompts/scoring.prompt'
import type { ScoredProposal } from '@intent/agents-shared'

export class ScoringOrchestrator {
  private readonly claude: Anthropic

  constructor() {
    this.claude = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] })
  }

  async rankProposals(proposals: AgentProposal[], intent: Intent): Promise<ScoredProposal[]> {
    if (proposals.length === 0) return []

    const response = await this.claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: scoringSystemPrompt,
      messages: [{ role: 'user', content: buildScoringUserPrompt(proposals, intent) }],
    })

    const content = response.content[0]
    if (content.type !== 'text') return []

    // TODO: parse JSON response into ScoredProposal[]
    try {
      const jsonMatch = content.text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return []
      return JSON.parse(jsonMatch[0]) as ScoredProposal[]
    } catch {
      return []
    }
  }
}