import type { AgentProposal, Intent } from '@intent/types'

import { AgentRegistry } from '../core/agent-registry'
import { AgentRunner } from '../core/agent-runner'

export class CompetitionOrchestrator {
  private readonly runner: AgentRunner

  constructor(registry: AgentRegistry) {
    this.runner = new AgentRunner(registry.getAll())
  }

  async runCompetition(intent: Intent, competitionId: string): Promise<AgentProposal[]> {
    // TODO: add timeout per competition window
    const proposals = await this.runner.collectProposals(intent, competitionId)
    return proposals
  }
}