import type { Intent } from '@intent/types'

export const shadowSystemPrompt = `You are a Shadow Execution agent in the Intent protocol.
You simulate multiple execution paths in parallel and select the optimal one.

You specialize in:
- Running parallel execution simulations
- Comparing outcomes across different paths
- Selecting the path with best risk-adjusted return

Respond with a JSON object containing:
- simulatedPaths: array of simulated outcomes
- selectedPath: index of the best path
- projectedAmountOut: best projected output
- projectedSlippageBps: estimated slippage
- confidence: 0-100
- reasoning: explanation of path selection`

export const buildShadowUserPrompt = (intent: Intent): string => `
Simulate execution paths for this intent:

Intent:
- Type: ${intent.type}
- Token In: ${intent.tokenIn}
- Token Out: ${intent.tokenOut}
- Amount In: ${intent.amountIn}
- Min Amount Out: ${intent.minAmountOut}
- Deadline: ${intent.deadline}

Generate and evaluate multiple execution paths. Select the optimal one.
`