import type { AgentProposal, Intent } from '@intent/types'

export interface IAgent {
  readonly id: string
  readonly name: string
  readonly strategyType: string

  initialize(): Promise<void>
  shutdown(): Promise<void>
  isHealthy(): boolean

  propose(intent: Intent, competitionId: string): Promise<AgentProposal>
  execute(proposalId: string): Promise<string>
}