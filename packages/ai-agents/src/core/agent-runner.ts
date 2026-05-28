import type { AgentProposal, Intent } from '@intent/types'

import type { BaseAIAgent } from './base-agent'

export class AgentRunner {
  private readonly agents: BaseAIAgent[]

  constructor(agents: BaseAIAgent[]) {
    this.agents = agents
  }

  async initializeAll(): Promise<void> {
    await Promise.all(this.agents.map((a) => a.initialize()))
  }

  async shutdownAll(): Promise<void> {
    await Promise.all(this.agents.map((a) => a.shutdown()))
  }

  async collectProposals(intent: Intent, competitionId: string): Promise<AgentProposal[]> {
    const results = await Promise.allSettled(
      this.agents
        .filter((a) => a.isHealthy())
        .map((a) => a.propose(intent, competitionId))
    )

    return results
      .filter((r): r is PromiseFulfilledResult<AgentProposal> => r.status === 'fulfilled')
      .map((r) => r.value)
  }
}