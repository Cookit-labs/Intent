import { WEBSOCKET_CHANNELS } from '@intent/config'

// TODO: initialize Redis publisher
export class EventPublisher {
  async publishCompetitionStarted(intentId: string, competitionId: string): Promise<void> {
    // TODO: publish to WEBSOCKET_CHANNELS.COMPETITION_STARTED Redis channel
    console.warn(`[publisher] ${WEBSOCKET_CHANNELS.COMPETITION_STARTED} ${intentId} ${competitionId}`)
  }

  async publishWinner(competitionId: string, winnerAgentId: string): Promise<void> {
    // TODO: publish to WEBSOCKET_CHANNELS.COMPETITION_WINNER
    console.warn(`[publisher] winner ${competitionId} ${winnerAgentId}`)
  }
}