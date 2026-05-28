export interface TWAPConfig {
  intervals: number
  intervalDurationMs: number
  maxSlippageBps: number
  adaptiveIntervals: boolean
}

export interface MomentumConfig {
  lookbackPeriod: number
  momentumThreshold: number
  positionSizeMultiplier: number
}

export interface ShadowConfig {
  simulationDepth: number
  confidenceThreshold: number
  parallelSimulations: number
}

export type StrategyConfig = TWAPConfig | MomentumConfig | ShadowConfig