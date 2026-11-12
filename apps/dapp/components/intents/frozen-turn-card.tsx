'use client'

import type { ChainAction } from '../../hooks/use-chain-action'
import type { TurnCard } from '../../lib/chat/turn-card'
import type { PreparedAction } from '../../lib/chains/types'
import { FrozenPayoutCard } from './cashout-card'
import { ChainActionConfirm } from './chain-action-confirm'
import { FrozenNairaCard } from './naira-payout-card'

const nothing = (): void => undefined

/** A sign card as it ended. Every button is gone, and there is nothing in it to sign. */
function frozenAction(card: Extract<TurnCard, { kind: 'chain' }>): ChainAction {
  return {
    phase: card.phase,
    ...(card.prepared !== undefined
      ? { prepared: { ...card.prepared, signing: undefined } as unknown as PreparedAction }
      : {}),
    ...(card.hash !== undefined ? { hash: card.hash } : {}),
    ...(card.explorerUrl !== undefined ? { explorerUrl: card.explorerUrl } : {}),
    ...(card.error !== undefined ? { error: card.error } : {}),
    signed: false,
    requested: false,
    canContinue: false,
    release: nothing,
    prepare: nothing,
    refuse: nothing,
    prepareExit: nothing,
    continueSetup: nothing,
    confirm: nothing,
    reset: nothing,
  }
}

/** The last screen of a card whose turn is behind the person, in the same card it was shown in. */
export function FrozenTurnCard({ card }: { card: TurnCard }): JSX.Element {
  if (card.kind === 'weave') return <FrozenPayoutCard card={card} />
  if (card.kind === 'linq') return <FrozenNairaCard card={card} />
  return <ChainActionConfirm action={frozenAction(card)} frozen />
}
