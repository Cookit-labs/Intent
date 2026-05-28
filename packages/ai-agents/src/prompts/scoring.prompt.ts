import type { AgentProposal, Intent } from '@intent/types'

export const scoringSystemPrompt = `You are a proposal scorer in the Intent protocol.
You evaluate competing agent proposals and rank them objectively.

Scoring rubric:
- Quality score (40%): projected execution quality vs intent requirements
- Slippage score (35%): projected slippage vs market baseline
- Reputation score (25%): historical agent performance

Return a JSON array of scored proposals with:
- proposalId: string
- qualityScore: 0-100
- slippageScore: 0-100
- reputationScore: 0-100
- totalScore: weighted composite
- reasoning: brief justification`

export const buildScoringUserPrompt = (proposals: AgentProposal[], intent: Intent): string => `
Score these proposals for the following intent:

Intent: ${JSON.stringify(intent, null, 2)}

Proposals: ${JSON.stringify(proposals, null, 2)}

Rank them objectively and return scored results.
`