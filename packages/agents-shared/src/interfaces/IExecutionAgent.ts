import type { ExecutionResult, Intent } from '@intent/types'

import type { IAgent } from './IAgent'

export interface IExecutionAgent extends IAgent {
  simulate(intent: Intent): Promise<SimulationResult>
  execute(proposalId: string): Promise<ExecutionResult>
  validateExecution(txHash: string): Promise<boolean>
}

export interface SimulationResult {
  projectedAmountOut: string
  projectedSlippage: number
  estimatedGas: string
  confidence: number
  reasoning?: string
}