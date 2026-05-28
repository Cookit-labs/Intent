import Anthropic from '@anthropic-ai/sdk'
import type { AgentProposal, Intent } from '@intent/types'

import type { IAgent } from '@intent/agents-shared'

export abstract class BaseAIAgent implements IAgent {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly strategyType: string

  protected readonly claude: Anthropic
  protected healthy = false

  constructor() {
    this.claude = new Anthropic({
      apiKey: process.env['ANTHROPIC_API_KEY'],
    })
  }

  async initialize(): Promise<void> {
    this.healthy = true
    console.warn(`[${this.name}] initialized`)
  }

  async shutdown(): Promise<void> {
    this.healthy = false
    console.warn(`[${this.name}] shutdown`)
  }

  isHealthy(): boolean {
    return this.healthy
  }

  abstract propose(intent: Intent, competitionId: string): Promise<AgentProposal>

  async execute(proposalId: string): Promise<string> {
    // TODO: implement execution
    throw new Error(`execute not implemented for ${this.name}: proposalId=${proposalId}`)
  }

  protected async callClaude(
    systemPrompt: string,
    userMessage: string,
    tools?: Anthropic.Tool[]
  ): Promise<Anthropic.Message> {
    return this.claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      ...(tools && tools.length > 0 ? { tools } : {}),
    })
  }
}