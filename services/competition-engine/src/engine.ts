import type { Competition, Intent } from '@intent/types'

// TODO: implement competition lifecycle state machine
export class CompetitionEngine {
  async start(intent: Intent): Promise<Competition> {
    // TODO: create competition, set window timer, collect proposals
    throw new Error('not implemented')
  }

  async close(competitionId: string): Promise<void> {
    // TODO: stop accepting proposals, score, select winner
    throw new Error('not implemented')
  }
}