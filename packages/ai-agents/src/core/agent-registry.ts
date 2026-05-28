import type { BaseAIAgent } from './base-agent'

export class AgentRegistry {
  private readonly agents = new Map<string, BaseAIAgent>()

  register(agent: BaseAIAgent): void {
    this.agents.set(agent.id, agent)
  }

  get(id: string): BaseAIAgent | undefined {
    return this.agents.get(id)
  }

  getAll(): BaseAIAgent[] {
    return Array.from(this.agents.values())
  }

  getActive(): BaseAIAgent[] {
    return this.getAll().filter((a) => a.isHealthy())
  }
}