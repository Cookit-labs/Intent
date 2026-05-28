export type AgentEventType =
  | 'agent:initialized'
  | 'agent:proposal:submitted'
  | 'agent:execution:started'
  | 'agent:execution:completed'
  | 'agent:execution:failed'
  | 'agent:shutdown'

export interface AgentEvent<T = unknown> {
  type: AgentEventType
  agentId: string
  data: T
  timestamp: string
}