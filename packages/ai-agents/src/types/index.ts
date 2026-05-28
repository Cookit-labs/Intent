export interface AgentConfig {
  id: string
  enabled: boolean
  maxConcurrentProposals: number
  timeoutMs: number
}

export interface OrchestratorConfig {
  competitionWindowMs: number
  maxProposalsPerCompetition: number
  agents: AgentConfig[]
}