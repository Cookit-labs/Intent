'use client'

import { cn } from '@intent/ui'
import { Bell, Clock, Inbox, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useChain } from '../../providers/chain-provider'
import { useCompetition } from '../../hooks/use-competition'
import { agentsFromProposals } from '../../lib/agents/competition'
import type { CreateIntentInput } from '@intent/types'

import {
  useCancelIntent,
  useCreateIntent,
  usePlaceIntent,
  useSettleIntent,
} from '../../hooks/use-intent'
import { useWallet } from '../../hooks/use-wallet'
import { checkAffordability } from '../../lib/affordability'
import { isLimitType } from '../../lib/intent-kind'
import { fetchStellarBalances } from '../../lib/stellar-account'
import { useQuery } from '@tanstack/react-query'
import { OpenIntentCard } from './open-intent-card'
import { ChatHistoryPanel } from './chat-history-panel'
import { StandingRulesPanel } from './standing-rules-panel'
import { StandingInboxPanel } from './standing-inbox-panel'
import { useStandingRules } from '../../hooks/use-standing-rules'
import { useStandingInbox } from '../../hooks/use-standing-inbox'
import type { StandingRuleRecord } from '../../lib/api/standing-client'
import { parseStandingIntent } from '../../lib/parse-standing'
import {
  clearTurns,
  loadTurns,
  saveTurn,
  syncTurns,
  updateTurn,
  type ChatTurn,
} from '../../lib/chat-history'
import { backfillFromLedger } from '../../lib/swap/backfill'
import { parseIntent, type ParsedIntent } from '../../lib/parse-intent'
import { CompetitionPanel } from './competition-panel'
import { SwapConfirm } from './swap-confirm'
import { useSwapExecution } from '../../hooks/use-swap-execution'
import { useLimitOrder } from '../../hooks/use-limit-order'
import { usePlanExecution } from '../../hooks/use-plan-execution'
import { PlanConfirm } from './plan-confirm'
import { useSequence } from '../../hooks/use-sequence'
import { SequenceConfirm } from './sequence-confirm'
import {
  parseCompoundIntent,
  parseOfframpOnlyIntent,
  parseSupplyOnlyIntent,
  type FollowOnAction,
} from '../../lib/parse-compound'
import type { AnchorId } from '../../lib/offramp/anchors'
import { isAnchorId } from '../../lib/offramp/anchors'
import type { WithdrawLimits } from '../../lib/offramp/sep24'
import { estimatedReceiveOf } from '../../lib/offramp/labels'
import { useSupply } from '../../hooks/use-supply'
import { SupplyConfirm } from './supply-confirm'
import { usePerp } from '../../hooks/use-perp'
import { PerpConfirm } from './perp-confirm'
import { parsePerpIntent } from '../../lib/parse-perp'
import { tradeableSymbols } from '../../lib/swap/asset-registry'
import { BLEND_XLM } from '../../lib/lend/reserves'
import { lendingVenueName } from '../../lib/lend/venues'
import { IntentConfirm, type UnderstoodIntent } from './intent-confirm'
import { resolveAsset, toBaseUnits } from '../../lib/swap/assets'
import { toPriceFraction } from '../../lib/swap/limit-price'
import { LimitConfirm } from './limit-confirm'
import { OpenOrders } from './open-orders'
import { ComposerInput } from './composer-input'
import { PriceTicker } from './price-ticker'

/**
 * The price of the only asset an anchor withdraws.
 *
 * A constant rather than a live rate, and that is exactly the point: USDC is a
 * dollar, so a dollar amount and a unit amount of it are the same number and
 * the offramp path needs no conversion. Named, so that the assumption is
 * visible at the one place that depends on it — and so that an asset with any
 * other price cannot quietly reuse that path.
 */
const USDC_PRICE_USD = 1

function TrafficLights(): JSX.Element {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      <span className="h-3 w-3 rounded-full" style={{ background: '#ff5f57' }} />
      <span className="h-3 w-3 rounded-full" style={{ background: '#febc2e' }} />
      <span className="h-3 w-3 rounded-full" style={{ background: '#28c840' }} />
    </div>
  )
}

export function IntentChat(): JSX.Element {
  const createIntent = useCreateIntent()
  const cancelIntent = useCancelIntent()
  const settleIntent = useSettleIntent()
  const placeIntent = usePlaceIntent()
  const [message, setMessage] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedIntent | null>(null)
  const [executingKey, setExecutingKey] = useState<string | null>(null)
  // The intent placed in this conversation, so an order that is waiting for a
  // price can be watched — and withdrawn — without leaving the chat.
  const [placedId, setPlacedId] = useState<string | null>(null)
  const [affordError, setAffordError] = useState<string | null>(null)
  // A market order held back until it settles, so an unsigned one leaves no
  // trace in history.
  const [pendingInput, setPendingInput] = useState<CreateIntentInput | null>(null)
  // The conversation being recorded, so its outcome can be attached later.
  const [turnId, setTurnId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  // Standing rules are watched here while the page is open and by the
  // server's tick while it is not. Both report to the same record.
  const standing = useStandingRules()
  // Rules the tick fired while nobody was looking. The panel shows the items
  // captured when it opened, so marking them seen does not empty it under
  // the user; the badge reads the live count.
  const inbox = useStandingInbox()
  const [inboxOpen, setInboxOpen] = useState(false)
  const [inboxItems, setInboxItems] = useState<StandingRuleRecord[]>([])
  // The rule a fired-rule email linked to, from ?rule=<id>.
  const [linkedRuleId, setLinkedRuleId] = useState<string | null>(null)
  const openedFromLink = useRef(false)

  function openInbox(): void {
    const items = inbox.items
    setInboxItems(items)
    setInboxOpen(true)
    setRulesOpen(false)
    setHistoryOpen(false)
    // Opening is seeing. The item has done its job once it has been looked
    // at; the rule itself stays in the rules list, still waiting to be signed.
    inbox.markSeen(items.map((i) => i.id))
  }

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('rule')
    if (id !== null && id !== '') setLinkedRuleId(id)
  }, [])

  // Opens on the linked rule once the inbox has answered, and only once: a
  // user who closes it should not have it reopen on the next poll.
  useEffect(() => {
    if (linkedRuleId === null || !inbox.loaded || openedFromLink.current) return
    openedFromLink.current = true
    openInbox()
    // `openInbox` reads the current inbox; re-running on its identity would
    // reopen the panel on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRuleId, inbox.loaded])
  const [turns, setTurns] = useState<ChatTurn[]>([])
  // A conversation reopened from history. While set, the panel renders what
  // was recorded rather than starting a new competition — reopening used to
  // resubmit the text, which threw away the agents' answers and produced a
  // different set, so nothing was actually preserved.
  const [restored, setRestored] = useState<ChatTurn | null>(null)
  // What the intent asked to happen after the trade, when it asked for
  // anything. Held rather than acted on: the sequence starts when an agent is
  // chosen, not when the sentence is typed.
  const [followOn, setFollowOn] = useState<FollowOnAction | null>(null)
  // A reading awaiting confirmation. While set, no competition runs: the moment
  // to catch a misread instruction is before the agents spend a minute arguing
  // about a trade that was never the one asked for.
  const [pending, setPending] = useState<UnderstoodIntent | null>(null)
  const [parsing, setParsing] = useState(false)

  const { slug } = useChain()
  const { address, isConnected } = useWallet()
  // Past intents belong to a wallet. With none connected there is nothing
  // to attribute them to, so the overlay closes and its button goes away.
  useEffect(() => {
    if (!isConnected) setHistoryOpen(false)
  }, [isConnected])
  // History lives on the server; the local copy is a cache. Refilled whenever
  // the wallet or chain changes, so clearing site data — or opening the app on
  // another device — shows the trades that actually happened rather than an
  // empty list.
  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      // The server first, so anything already recorded is in hand before the
      // ledger is consulted and a recorded turn is never mistaken for missing.
      const fromServer = await syncTurns(slug)
      if (cancelled) return
      setTurns(fromServer)

      // Then the chain. A trade made before this sync existed, on another
      // device, or during a session whose sign-in failed, is on Stellar and
      // nowhere else — and an account with real swaps should not show an empty
      // history. Writes go through `saveTurn`, so each one reaches the
      // database like any other.
      if (address === undefined) return
      const result = await backfillFromLedger(address, slug)
      if (cancelled || result.written === 0) return

      // Re-read rather than appending: `saveTurn` has already merged each row
      // into the store, and reading back keeps one ordering rather than two.
      setTurns(loadTurns(slug))
    }

    void load().catch(() => {
      // Both halves already degrade on their own; a failure here must not
      // empty a history panel that has perfectly good cached rows.
    })

    return () => {
      cancelled = true
    }
  }, [slug, address])

  // Balances, so an order can be checked against what the account actually
  // holds before it is placed rather than after it fails.
  const { data: balances } = useQuery({
    queryKey: ['stellar-balances', address],
    queryFn: () => fetchStellarBalances(address as string),
    enabled: slug === 'stellar' && isConnected && address !== undefined,
    staleTime: 15_000,
  })

  // Which markets the perps venue lists, so "long XLM" is recognised at all.
  // A live read rather than a table: the venue's markets are its own fact,
  // and an unreachable venue means no perp is read — the trade parser then
  // sees the sentence, which is the same as before perps existed.
  const { data: perpMarkets } = useQuery({
    queryKey: ['perp-markets'],
    queryFn: async () =>
      (await (await fetch('/api/perps/markets')).json()) as {
        online: boolean
        markets: { asset: string }[]
      },
    enabled: slug === 'stellar',
    staleTime: 60_000,
  })
  const perpSymbols = perpMarkets?.online === true ? perpMarkets.markets.map((m) => m.asset) : []

  // Live agents, always. There is no offline race any more: when the agents
  // are not online the route says so and the panel shows it. A build-time
  // toggle used to select a mock competition here, and a stale bundle once
  // ran it silently while the server's agents worked — every check passed and
  // the screen showed canned proposals nobody could execute.
  const live = useCompetition(restored === null ? parsed : null, slug)
  const liveCompetition = live

  // A restored turn is already decided: every agent revealed, a winner picked.
  const competition =
    restored !== null
      ? {
          proposals: restored.proposals,
          revealed: Object.fromEntries(Object.keys(restored.proposals).map((k) => [k, true])),
          // Rebuilt from what the row recorded: name and, when tracked, the
          // model. Nothing about today's line-up is assumed for an old race.
          agents: agentsFromProposals(restored.proposals),
          phase: 'decided' as const,
          secondsLeft: 0,
          winner: restored.winner,
        }
      : liveCompetition

  // The route of whichever agent the user chose — not the winner's. Executing
  // always signed `live.route`, so picking any other agent quietly submitted
  // the recommended agent's trade instead of the one on the card that was
  // clicked. Falls back to the winner's route only when an agent named none.
  //
  // Memoised on the identifying values rather than recomputed inline: the
  // consumer resets its state whenever this reference changes, so returning a
  // fresh one on every render reset the confirm card continuously and it never
  // appeared.
  // Routes come from the restored turn when one is open, so a reopened
  // conversation is still executable rather than a read-only transcript.
  const routesByAgent = restored?.routesByAgent ?? live.routesByAgent
  const winnerRoute = restored !== null ? undefined : live.route
  const chosenRoute = useMemo(() => {
    if (executingKey === null) return undefined
    return routesByAgent[executingKey] ?? winnerRoute
  }, [executingKey, routesByAgent, winnerRoute])

  const swap = useSwapExecution(chosenRoute)

  // A resting order is a different transaction from a swap and has its own
  // state: it can be refused before it is ever built, which a swap cannot.
  const limit = useLimitOrder()
  // Multi-step plans. Separate from the swap hook because a plan is a
  // different thing to approve: an ordered list rather than one number.
  const planExec = usePlanExecution()
  const sequence = useSequence()
  // Supplying an asset already held. A separate shape from a sequence: there is
  // no earlier step whose output has to be carried.
  const supply = useSupply()
  // A leveraged position on Noether. Its own shape again: no route, no
  // competition, and a sign-in with the venue before anything is built.
  const perp = usePerp()

  // Clicking Execute puts the swap into `review`, which renders the confirm
  // card — but that card sits below four agent cards in a scrolling panel, so
  // it appeared off-screen. The click looked like it had done nothing, and the
  // wallet prompt (which is the *second* step, on that card) never came
  // because the button was never seen.
  const confirmRef = useRef<HTMLDivElement | null>(null)
  // The agent most recently chosen. A ref rather than `executingKey`, because
  // the offramp branch below reads it from inside an async closure that
  // captured the state at click time and would never see a later pick.
  //
  // Mirrored from the state rather than assigned at the click, which went
  // stale on every path that clears `executingKey` without a click — a reset,
  // a failed swap, a conversation restored from history. The ref then still
  // named the last agent picked, so an anchor-limits fetch left over from that
  // pick passed its own guard and prepared a sequence into a chat that had
  // moved on. The same pattern as `phaseRef` in `use-offramp-session.ts`.
  const latestPickRef = useRef<string | null>(null)
  useEffect(() => {
    latestPickRef.current = executingKey
  }, [executingKey])
  const awaitingConfirm = swap.phase === 'review'
  useEffect(() => {
    if (!awaitingConfirm) return
    confirmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [awaitingConfirm])

  // The swap's hash belongs on the intent that asked for it. Without this the
  // hash was shown once in the confirmation card and then dropped, leaving
  // history unable to link to a trade that really happened.
  const settledHash = swap.phase === 'settled' ? swap.hash : undefined
  useEffect(() => {
    if (settledHash === undefined) return

    // The conversation keeps the outcome, so history can link to the trade.
    if (turnId !== null) {
      updateTurn(turnId, { txHash: settledHash })
      setTurns(loadTurns(slug))
    }

    // A limit order already exists; attach the hash to it.
    if (placedId !== null) {
      settleIntent.mutate({ id: placedId, txHash: settledHash })
      return
    }

    // A market order is created only now, already settled — so it appears in
    // history exactly when the trade became real, and never before.
    if (pendingInput !== null) {
      const input = pendingInput
      setPendingInput(null)
      createIntent.mutate(input, {
        onSuccess: (created) => {
          setPlacedId(created.id)
          settleIntent.mutate({ id: created.id, txHash: settledHash })
        },
      })
    }
    // Deliberately narrow: re-running on every render of the mutation objects
    // would record the same hash repeatedly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedId, settledHash, pendingInput])

  // A sequence settles through its own hook, so the effect above never sees it
  // and the trade was missing from history entirely — it happened on-chain and
  // left no record in the app.
  //
  // Recorded on the *first* step's hash rather than the last. That step is a
  // real swap that really settled, and it stays true whether or not the user
  // goes on to supply: someone who stops after step one still made a trade,
  // and history should show it.
  const sequenceHash = sequence.steps[0]?.hash
  // Every settled step, so history can list the whole bundle rather than its
  // first transaction. Serialised for the dependency array below: the steps
  // array is rebuilt on each render, so comparing it by reference would
  // re-record on every tick.
  const sequenceSteps = JSON.stringify(sequence.steps.filter((step) => step.hash !== undefined))
  // An offramp-only run has no trade, so `parsed` is deliberately null — and
  // this effect bailed on exactly that, which meant a withdrawal that really
  // paid out left no record anywhere: not in history, and so not under Open
  // positions either, where its anchor status is the only way to see the fiat
  // side. A settled sequence is recorded whether or not a trade preceded it.
  const sequenceKind = sequence.kind
  useEffect(() => {
    if (sequenceHash === undefined) return
    if (parsed === null && sequenceKind !== 'offramp-only') return

    if (turnId !== null) {
      updateTurn(
        turnId,
        {
          txHash: sequenceHash,
          // Recorded as a bundle, not a swap. One instruction became several
          // transactions, and naming it after the first would hide the rest.
          bundle: (JSON.parse(sequenceSteps) as typeof sequence.steps).map((step) => ({
            label: step.label,
            ...(step.hash !== undefined ? { hash: step.hash } : {}),
            ...(step.explorerUrl !== undefined ? { explorerUrl: step.explorerUrl } : {}),
            ...(step.positionUrl !== undefined ? { positionUrl: step.positionUrl } : {}),
            // The venue the step named, when it named one. Before steps
            // carried a venue, a position link with no anchor meant Blend.
            ...(step.venue !== undefined
              ? { venue: step.venue }
              : step.positionUrl !== undefined && step.anchor === undefined
                ? { venue: 'Blend' }
                : {}),
            ...(step.anchor !== undefined ? { anchor: step.anchor, venue: 'Anchor' } : {}),
          })),
        },
        // A turn is only written once its competition is decided, and a
        // sequence can settle before that or after a tab switch that wrote
        // none. Without this the trade happened on-chain and history kept no
        // record of it at all.
        // `parsed.outcome` is the fallback text for a trade; an offramp-only
        // run has no parse to describe, so what the user typed is the whole
        // record of what was asked for.
        { chain: slug, text: message ?? parsed?.outcome ?? '' }
      )
      setTurns(loadTurns(slug))
    }

    // Only a trade becomes an intent on the backend. A withdrawal of USDC
    // already held is not one — there is no `input` to create, and inventing a
    // swap to carry it would put a trade that never happened in the activity
    // list.
    if (parsed === null) return

    createIntent.mutate(
      { ...parsed.input, chain: slug },
      {
        onSuccess: (created) => {
          setPlacedId(created.id)
          settleIntent.mutate({ id: created.id, txHash: sequenceHash })
        },
        // Recording to the backend needs a session, and without one this
        // rejects. Swallowing that was how a settled bundle came to be missing
        // from the activity list with nothing anywhere saying why — the trade
        // was real, the record simply never reached the server.
        //
        // The local chat-turn record above is already written, so the trade is
        // not lost; this only reports the half that did not persist.
        onError: (e) => {
          // eslint-disable-next-line no-console
          console.warn('[intent] settled bundle was not recorded on the server:', e)
        },
      }
    )
    // Narrow for the same reason as above: widening this re-records the hash
    // on every render of the mutation objects. `sequenceSteps` is a string, so
    // it changes only when a step actually settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequenceHash, sequenceSteps])

  // Declining in the wallet returns the swap to `review`, but the clicked
  // agent stayed marked as executing — its button spun forever and the others
  // could not be chosen. Releasing it lets the user pick again, including a
  // different agent.
  const swapFailed = swap.phase === 'failed'
  useEffect(() => {
    if (swapFailed) setExecutingKey(null)
  }, [swapFailed])

  useEffect(() => {
    setTurns(loadTurns(slug))
  }, [slug])

  // Record the conversation once the competition settles on a winner, so the
  // agents' reasoning survives a reload even if nothing is ever signed.
  // Only a live competition writes a turn. A restored one is already decided,
  // so saving it again would overwrite the record with a copy of itself and
  // drop the outcome fields it had accumulated.
  const decided = restored === null && liveCompetition.phase === 'decided'
  useEffect(() => {
    if (!decided || turnId === null || message === null) return
    saveTurn({
      id: turnId,
      chain: slug,
      text: message,
      createdAt: new Date().toISOString(),
      proposals: liveCompetition.proposals,
      winner: liveCompetition.winner,
      routesByAgent: live.routesByAgent,
    })
    setTurns(loadTurns(slug))
    // Keyed on the decision, not on the proposals object, which is rebuilt on
    // every frame of the reveal animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decided, turnId, message, slug])

  function handleSubmit(text: string): void {
    // A rule is not a trade. "Buy XLM if it drops to $0.16" describes when to
    // act, and running a competition on it now would execute at a price the
    // user explicitly said they did not want.
    //
    // Anything expressible as a resting order is deliberately *not* caught
    // here — the parser declines it, so it becomes a real order on Stellar's
    // book rather than a promise this app has to stay open to keep.
    const rule = parseStandingIntent(text, swap.usdPrices ?? {}, slug)
    if (rule !== null) {
      standing.add(rule)
      setMessage(text)
      setParsed(null)
      setRulesOpen(true)
      return
    }

    setMessage(text)
    // Anything left from a previous attempt goes now. Nothing was signed, so
    // nothing should survive the restart.
    sequence.reset()
    setExecutingKey(null)
    setPlacedId(null)
    setAffordError(null)
    setPendingInput(null)
    setTurnId(crypto.randomUUID())
    setHistoryOpen(false)
    setRestored(null)
    setPending(null)

    // "Supply my XLM to Blend" is not a trade at all, and the trade parser
    // reads it as a market *buy* of XLM — spending USDC the user never
    // offered. Checked before anything else, because every parser below
    // assumes an intent is a trade.
    const supplyOnly = parseSupplyOnlyIntent(text, tradeableSymbols())
    if (supplyOnly !== null && slug === 'stellar') {
      setParsed(null)
      setFollowOn(null)

      // Only Blend takes a balance already held. A DeFindex deposit exists
      // here as the second step of a swap, sized to what the swap delivered;
      // there is no single-step path to it yet. Said by name and refused,
      // because supplying to Blend instead would be exactly the substitution
      // the parser refuses everywhere else.
      if (supplyOnly.venue !== 'blend') {
        setAffordError(
          `Supplying a balance you already hold to ${lendingVenueName(supplyOnly.venue)} is not supported yet. ` +
            `Swap into ${supplyOnly.asset} and supply it in one intent, or name Blend.`
        )
        return
      }
      // Three conversions, and getting any of them wrong moves the wrong
      // amount of money.
      //
      // A dollar figure is not a token count: "$20 worth of XLM" is about 125
      // XLM, and supplying 20 would be a sixth of what was asked. An absent
      // amount means the whole balance. And the route takes stroops, so a
      // display figure passed straight through supplies a millionth of it.
      const price = swap.usdPrices?.[supplyOnly.asset]
      if (supplyOnly.amountIsUsd === true && (price === undefined || price <= 0)) {
        // Better to say nothing can be priced than to guess a rate and supply
        // an amount the user never chose.
        setAffordError(`No live price for ${supplyOnly.asset}, so a dollar amount cannot be sized.`)
        return
      }

      const units =
        supplyOnly.amount === undefined
          ? (balances?.xlm ?? '0')
          : supplyOnly.amountIsUsd === true
            ? (Number(supplyOnly.amount) / (price as number)).toFixed(7)
            : supplyOnly.amount

      supply.prepare({
        assetId: BLEND_XLM,
        symbol: supplyOnly.asset,
        amount: toBaseUnits(units),
      })
      return
    }
    supply.reset()
    perp.reset()

    // "Long XLM 10x with 50 USDC" is a leveraged position, not a purchase,
    // and the trade parser would read it as a spot buy of XLM with USDC. The
    // model has no vocabulary for it either — nothing in the proposal schema
    // can express a perp — so it is read here, before both, and takes the
    // direct flow: no route, no competition, one position to review.
    const regexPerp = parsePerpIntent(text, perpSymbols)
    if (regexPerp !== null && slug === 'stellar') {
      setParsed(null)
      setFollowOn(null)
      perp.prepare(regexPerp)
      return
    }

    // The regex reading, computed first and always. It is the fallback, so it
    // must never depend on the model answering — an outage or a missing key has
    // to leave the app exactly as capable as it was before the model existed.
    //
    // Parsed against the same live prices the server uses. Without them this
    // fell back to an indicative table that had XLM at $0.58 against a real
    // ~$0.18, so the same sentence produced one size here and a different one
    // in the competition.
    const single = parseIntent(text, swap.usdPrices)
    const regexFollowOn = parseCompoundIntent(text, swap.usdPrices ?? {})?.followOn ?? null
    // "Withdraw 2 USDC to my bank" is not a trade at all, and the trade parser
    // reads it as one. Computed here with the rest of the fallback reading, so
    // an outage leaves this path exactly as capable as the model does.
    const regexOfframpOnly = parseOfframpOnlyIntent(text)

    // Reading by meaning rather than by wording. A regex recognises surface
    // forms and people do not write in surface forms: measured across twelve
    // ways of writing one instruction it understood five, and the misses split
    // evenly between an unmatched marker and an unlisted verb. Widening either
    // list closes those and fails on the next seven.
    void (async () => {
      setParsing(true)
      let read: UnderstoodIntent | null = null
      try {
        const res = await fetch('/api/intent/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, chain: slug }),
        })
        const body = (await res.json()) as {
          understood?: boolean
          action?: 'swap' | 'supply' | 'borrow' | 'repay' | 'offramp'
          tokenIn?: string
          tokenOut?: string
          amountUsd?: number
          amountStated?: boolean
          amountIsUsd?: boolean
          followOn?: FollowOnAction | null
        }

        // A supply is not a trade, and the trade path below would read it as
        // one — buying the asset the user already holds. The model is asked
        // this question directly because the regex fallback cannot answer it
        // for every phrasing: "Blende" defeated an exact venue match, and the
        // sentence was executed as a swap.
        // Borrowing and repaying are read correctly and deliberately not
        // executed from here. Both only make sense against a specific
        // collateral position, and the decision needs a health factor and a
        // liquidation price beside it — none of which belong in a chat reply.
        // Pointing at the place that has them is more honest than running a
        // competition on an intent no agent can fill.
        if (
          body.understood === true &&
          (body.action === 'borrow' || body.action === 'repay') &&
          slug === 'stellar'
        ) {
          const verb = body.action === 'borrow' ? 'Borrowing' : 'Repaying'
          setParsed(null)
          setFollowOn(null)
          setAffordError(
            `${verb} happens on your position rather than through an intent, because it depends on the collateral behind it. Open the History tab to see your Blend position, what it can support, and the price at which it would be liquidated.`
          )
          return
        }

        if (body.understood === true && body.action === 'offramp' && slug === 'stellar') {
          // No trade: the USDC is already held. Amount is optional — the
          // anchor asks in its own page when none was named.
          const stated = body.amountStated === true
          // Read and honoured rather than ignored: the asset here is always
          // USDC, whose price is one dollar, so the dollar reading and the unit
          // reading of the same figure are the same amount — which is why this
          // branch converts nothing. An asset with any other price would have
          // to divide by it here rather than inherit this silence.
          const amountIsUsd = body.amountIsUsd === true
          const units = (body.amountUsd ?? 0) / (amountIsUsd ? USDC_PRICE_USD : 1)
          const amount = stated ? String(units) : undefined
          const anchor =
            body.followOn?.kind === 'offramp' && isAnchorId(body.followOn.venue)
              ? body.followOn.venue
              : 'testanchor'
          setParsed(null)
          setFollowOn(null)
          sequence.prepare({
            kind: 'offramp-only',
            anchor,
            ...(amount !== undefined && amount !== '0' ? { amount } : {}),
          })
          return
        }

        if (
          body.understood === true &&
          body.action === 'supply' &&
          body.tokenIn !== undefined &&
          slug === 'stellar'
        ) {
          const symbol = body.tokenIn
          const price = swap.usdPrices?.[symbol]
          const stated = body.amountStated === true

          if (stated && body.amountIsUsd === true && (price === undefined || price <= 0)) {
            setAffordError(`No live price for ${symbol}, so a dollar amount cannot be sized.`)
            return
          }

          const units = !stated
            ? (balances?.xlm ?? '0')
            : body.amountIsUsd === true
              ? ((body.amountUsd ?? 0) / (price as number)).toFixed(7)
              : String(body.amountUsd ?? 0)

          setParsed(null)
          setFollowOn(null)
          supply.prepare({ assetId: BLEND_XLM, symbol, amount: toBaseUnits(units) })
          return
        }
        if (body.understood === true && body.tokenIn !== undefined && body.tokenOut !== undefined) {
          read = {
            text,
            tokenIn: body.tokenIn,
            tokenOut: body.tokenOut,
            amountUsd: body.amountUsd ?? 0,
            amountStated: body.amountStated === true,
            followOn: body.followOn ?? null,
          }
        }
      } catch {
        // Left null: the regex reading below is the answer.
      } finally {
        // In a finally, because the branches above return early for a supply,
        // a borrow and a repay. Placed after the try, this was skipped on
        // every one of those paths and "Reading your intent…" stayed lit
        // under a message that had already been answered.
        setParsing(false)
      }

      // The model did not answer, and the regex read a withdrawal of USDC
      // already held. Same destination as the branch above: one step, no
      // competition, because there is no trade for agents to compete over.
      if (read === null && regexOfframpOnly !== null && slug === 'stellar') {
        setParsed(null)
        setFollowOn(null)
        sequence.prepare({
          kind: 'offramp-only',
          anchor: isAnchorId(regexOfframpOnly.venue) ? regexOfframpOnly.venue : 'testanchor',
          ...(regexOfframpOnly.amount !== undefined ? { amount: regexOfframpOnly.amount } : {}),
        })
        return
      }

      // A second action is worth confirming, whichever parser found it. The
      // instruction carries more than a swap, and a follow-on silently dropped
      // or silently added is the misreading that costs the user real money.
      const readFollowOn = read?.followOn ?? regexFollowOn
      if (readFollowOn !== null) {
        setPending({
          text,
          tokenIn: read?.tokenIn ?? single.input.tokenIn,
          tokenOut: read?.tokenOut ?? single.input.tokenOut,
          amountUsd: read?.amountStated === true ? read.amountUsd : single.escrowUsd,
          amountStated: read?.amountStated ?? true,
          followOn: readFollowOn,
        })
        return
      }

      // An ordinary swap reads the same whichever parser handled it, so it
      // starts immediately. Interrupting the common case would be a tax on it
      // for the benefit of the rare one.
      setFollowOn(null)
      setParsed(single)
    })()
  }

  /**
   * Runs a confirmed reading.
   *
   * `withFollowOn` is false when the user said they meant only the trade, which
   * must not require retyping the sentence.
   */
  function startPending(withFollowOn: boolean): void {
    const confirmed = pending
    if (confirmed === null) return

    setPending(null)
    setFollowOn(withFollowOn ? confirmed.followOn : null)

    // Only USDC reaches an anchor. Said here rather than after a competition,
    // because the second half of the instruction cannot be done at all and a
    // minute of agents arguing would not change that.
    if (
      withFollowOn &&
      confirmed.followOn !== null &&
      confirmed.followOn.kind === 'offramp' &&
      confirmed.tokenOut !== 'USDC'
    ) {
      setAffordError(
        `Only USDC can be withdrawn to a bank. Ask for the trade into USDC — "sell ${confirmed.tokenIn} for USDC and send the dollars to my bank".`
      )
      return
    }

    // Re-parsed from the original text rather than rebuilt from the reading:
    // every downstream consumer expects a `ParsedIntent`, and the deterministic
    // parser is what derives escrow, base units and deadlines. The model
    // answers only what needs judgement.
    setParsed(parseIntent(confirmed.text, swap.usdPrices))
  }

  function handleReset(): void {
    setMessage(null)
    setParsed(null)
    setExecutingKey(null)
    setPlacedId(null)
    setAffordError(null)
    setPendingInput(null)
    setRestored(null)
    setTurnId(null)
    // Cleared with everything else. Leaving it behind kept a card from the
    // previous attempt on screen, mid-sequence, with nothing signed — which
    // read as a stuck transaction that had never existed.
    setFollowOn(null)
    sequence.reset()
  }

  function handleExecute(key: string): void {
    // Selecting an agent is not a commitment, so it must stay changeable.
    // Guarding on `executingKey` — set by the first Review click — meant the
    // first pick was final: every other card became unclickable before the
    // user had confirmed anything.
    //
    // A signature in flight is the real reason to refuse: past that point a
    // transaction is with the wallet or the network, and switching routes
    // would leave the wrong one submitted.
    const inFlight =
      swap.phase === 'signing' || swap.phase === 'submitting' || swap.phase === 'settled'
    if (!parsed || inFlight) return

    // Refuse an order the account cannot fund. Without this a wallet holding
    // $12 could open a $4,000 limit order, which the app then displayed as a
    // live position for hours — an order that could only ever fail.
    // Only refuse on a known shortfall. Balances load asynchronously, and
    // checking before they arrive reported "connect a wallet" to a connected
    // user and blocked the whole flow — a wallet that is merely slow is not a
    // wallet that cannot pay.
    if (slug === 'stellar' && balances !== undefined) {
      // A resting order also locks half a lumen until it is withdrawn, so it
      // needs more headroom than a swap that settles at once.
      const willRest = isLimitType(parsed.input.type) && parsed.limitPriceUsd !== undefined
      const afford = checkAffordability(
        parsed.input.amountIn,
        parsed.input.tokenIn,
        balances,
        willRest
      )
      if (!afford.ok) {
        setAffordError(afford.message)
        return
      }
    }
    setAffordError(null)
    setExecutingKey(key)
    if (turnId !== null) updateTurn(turnId, { executedBy: key })

    // Every intent is recorded, whichever way it goes. Skipping the record for
    // signable routes kept the user in the chat but left the trade out of
    // history entirely, so an executed limit buy simply never appeared.
    // The limit price travels with the intent. Parsed but never stored, it was
    // discarded at creation — so a limit order became indistinguishable from a
    // market order the moment it was placed, and filled immediately.
    //
    // Only a price the user actually named counts. `targetPriceUsd` falls back
    // to spot, so the old guard was true for every intent and stamped a limit
    // price equal to the current market onto orders that never asked for one.
    const isLimit = isLimitType(parsed.input.type)

    // The plan belongs to the agent the user chose. Its resting price has
    // already been settled against the live book server-side, so a price that
    // would cross the spread arrived here as a fill rather than as patience.
    //
    // A price the user typed still wins over the agent's: that is the one part
    // of an intent a model does not get to move.
    const chosenPlan = competition.proposals[key]
    const restingPrice =
      chosenPlan?.executionMode === 'rest'
        ? (parsed.limitPriceUsd ?? chosenPlan.restPriceUsd)
        : undefined

    const input = {
      ...parsed.input,
      chain: slug,
      ...(isLimit && parsed.limitPriceUsd !== undefined
        ? { limitPriceUsd: parsed.limitPriceUsd }
        : {}),
    }

    // A limit order is recorded now, because resting unfilled is what it does
    // and the user needs it listed to watch or withdraw.
    //
    // A market order is not. It is signed within moments or not at all, so
    // recording it at the click created a row for a trade that had not
    // happened and might never — one left unsigned sat in the list claiming
    // to be live forever. It is recorded when it settles, by the effect below.
    if (isLimit) {
      createIntent.mutate(input, {
        onSuccess: (created) => setPlacedId(created.id),
        onError: () => setExecutingKey(null),
      })

      if (slug === 'stellar' && restingPrice !== undefined) {
        limit.prepare({
          sellSymbol: parsed.input.tokenIn,
          buySymbol: parsed.input.tokenOut,
          amount: parsed.input.amountIn,
          limitPriceUsd: restingPrice,
        })
      }
      return
    }

    // A sequence: swap now, then supply the proceeds. Started here rather than
    // on submit, so it runs against the route the chosen agent actually picked
    // and inherits the same slippage floor as an ordinary swap. Building it at
    // submit time bypassed the competition entirely and quoted no floor at all.
    if (slug === 'stellar' && followOn !== null && followOn.kind === 'lend') {
      // The chosen agent's route, passed through untouched. A sequence builds
      // it with the ordinary swap builder, so whichever venue the agent picked
      // is the venue that executes — previously every sequence was forced down
      // a classic path payment, which on this pair delivers about a third of
      // what a Soroswap route does and so could never meet its own floor.
      const route = routesByAgent[key] ?? winnerRoute
      if (route !== undefined) {
        // Whose pool. A venue the user typed is theirs. "Supply it" leaves
        // the pool to the chosen agent, which was shown every configured
        // venue's rate precisely so it could choose — and whose choice was
        // validated server-side against what this deployment can reach.
        // An agent that named no pool falls back to the default.
        const agentsVenue =
          chosenPlan?.thenAction === 'lend' &&
          chosenPlan.thenVenue !== undefined &&
          chosenPlan.thenVenue !== ''
            ? chosenPlan.thenVenue
            : undefined
        const venue =
          followOn.venueNamed === true ? followOn.venue : (agentsVenue ?? followOn.venue)

        sequence.prepare({
          kind: 'swap-then-lend',
          quote: route,
          receiveSymbol: parsed.input.tokenOut,
          lendAsset: BLEND_XLM,
          venue,
          swapLabel: `Swap ${parsed.input.amountIn} ${parsed.input.tokenIn} for ${parsed.input.tokenOut}`,
        })
        return
      }

      // No executable route means no honest sequence. Falling through to the
      // ordinary swap path is better than building one that cannot fill.
    }

    // The same shape, ending at an anchor rather than a lending pool. The
    // anchor's limits are fetched before the sequence is prepared, so a size
    // it will refuse is said while the trade can still be cancelled.
    if (slug === 'stellar' && followOn !== null && followOn.kind === 'offramp') {
      const route = routesByAgent[key] ?? winnerRoute
      const anchor: AnchorId = isAnchorId(followOn.venue) ? followOn.venue : 'testanchor'
      if (route !== undefined && parsed.input.tokenOut === 'USDC') {
        // `destAmount`, in base units, converted to display — the field every
        // venue's quote actually carries. `receiveAmount` belongs to a
        // strict-receive request, so reading it here always gave undefined and
        // the size check below never ran.
        const estimated = estimatedReceiveOf(route)
        void (async () => {
          // The anchor's limits, so the size is checked before signature one.
          let limits: WithdrawLimits | undefined
          try {
            const res = await fetch(`/api/offramp/anchor?id=${anchor}`)
            const info = (await res.json()) as { limits?: WithdrawLimits | null; error?: string }
            if (!res.ok) {
              // An unreachable anchor was read as "no limits", so the size
              // warning silently disappeared and the user heard nothing at
              // all. Said out loud, and the sequence still prepared without
              // limits: the build route refuses an out-of-range withdrawal
              // later, so losing the early warning is the honest degradation
              // rather than a reason to refuse a trade the user asked for.
              setAffordError(
                `The anchor could not be reached: ${info.error ?? `the request failed (${res.status}).`}`
              )
            } else if (info.limits !== null && info.limits !== undefined) {
              limits = info.limits
            }
          } catch {
            // The same treatment for a network failure: said, and prepared
            // without limits.
            setAffordError('The anchor could not be reached: the network did not answer.')
          }
          // The user picked another agent while the anchor was being read.
          if (latestPickRef.current !== key) return
          sequence.prepare({
            kind: 'swap-then-offramp',
            quote: route,
            receiveSymbol: 'USDC',
            anchor,
            swapLabel: `Swap ${parsed.input.amountIn} ${parsed.input.tokenIn} for USDC`,
            ...(estimated !== undefined ? { estimatedReceive: estimated } : {}),
            ...(limits !== undefined ? { limits } : {}),
          })
        })()
        return
      }

      // A swap that does not deliver USDC cannot be offramped. Fall through to
      // the ordinary swap: the user said what they wanted and the app cannot
      // do the second half, which the pending card already made clear.
    }

    // A split is two actions in one signature: part filled now, the remainder
    // rested. It is the only proposal shape that becomes more than one
    // operation, and the reason four agents can produce genuinely different
    // transactions rather than four descriptions of the same one.
    if (
      slug === 'stellar' &&
      chosenPlan?.executionMode === 'split' &&
      chosenPlan.splitPct !== undefined &&
      restingPrice !== undefined
    ) {
      const total = Number(parsed.input.amountIn)
      const fillNow = (total * chosenPlan.splitPct) / 100
      const rested = total - fillNow

      const from = resolveAsset(parsed.input.tokenIn)
      const to = resolveAsset(parsed.input.tokenOut)

      if (from !== undefined && to !== undefined && fillNow > 0 && rested > 0) {
        planExec.prepare([
          {
            kind: 'swap',
            from,
            to,
            sendAmount: toBaseUnits(fillNow.toFixed(7)),
            // Priced server-side. The comment here used to say a nominal value
            // would be no protection and then pass one anyway: the network
            // enforces whatever floor it is given, and one stroop permits any
            // fill at all. Zero asks the build route to re-quote and apply the
            // same tolerance an ordinary swap gets.
            minReceive: '0',
          },
          {
            kind: 'rest',
            selling: from,
            buying: to,
            amount: rested.toFixed(7),
            price: toPriceFraction(String(restingPrice)),
          },
        ])
        return
      }
    }

    // A market-typed intent still reaches the book when the chosen agent
    // decided to wait. The execution shape belongs to the plan the user picked,
    // not to how the text was classified — that is what makes choosing a
    // different agent mean something.
    if (slug === 'stellar' && restingPrice !== undefined) {
      limit.prepare({
        sellSymbol: parsed.input.tokenIn,
        buySymbol: parsed.input.tokenOut,
        amount: parsed.input.amountIn,
        limitPriceUsd: restingPrice,
      })
      return
    }

    setPendingInput(input)
  }

  return (
    <div className="border-border bg-card flex h-[75vh] max-h-[720px] min-h-[420px] flex-col overflow-hidden rounded-xl border sm:min-h-[520px] sm:rounded-2xl">
      {/* Window chrome */}
      <div className="border-border relative flex shrink-0 items-center border-b px-4 py-3">
        <TrafficLights />
        {/* The rate every dollar amount on this page is sized against.
            "$20 worth of XLM" becomes a token count using this number, so
            showing it lets the user see the conversion before writing the
            sentence rather than after signing it. Hidden on narrow screens,
            where the centred label and the actions already compete. */}
        <span className="ml-3 hidden sm:inline-flex">
          <PriceTicker prices={swap.priceDetail} />
        </span>
        <span className="text-muted-foreground absolute left-1/2 -translate-x-1/2 text-xs">
          Live settlement
        </span>
        {/* Past conversations. The chat keeps nothing across a reload on its
            own, so without this the agents' reasoning is lost the moment the
            page refreshes or a second intent is composed. */}
        {isConnected ? (
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-label="Past intents"
            aria-expanded={historyOpen}
            className={cn(
              'ml-auto rounded-full p-1.5 transition-colors',
              historyOpen
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
            )}
          >
            <Clock className="h-4 w-4" />
          </button>
        ) : null}

        {/* Standing rules. Badged when one has come due, because a rule that
            is ready and unnoticed is the same as a rule that never fired. */}
        <button
          type="button"
          onClick={() => {
            setInboxOpen(false)
            setRulesOpen((v) => !v)
          }}
          aria-label="Standing rules"
          aria-expanded={rulesOpen}
          className={cn(
            'relative rounded-full p-1.5 transition-colors',
            rulesOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
          )}
        >
          <Bell className="h-4 w-4" />
          {standing.due.length > 0 ? (
            <span className="bg-foreground absolute right-1 top-1 h-1.5 w-1.5 rounded-full" />
          ) : null}
        </button>

        {/* The inbox: rules the server fired while nobody was looking. Badged
            with the count, because a firing that goes unnoticed is the same
            as one that never happened. */}
        <button
          type="button"
          onClick={() => (inboxOpen ? setInboxOpen(false) : openInbox())}
          aria-label="Fired rules"
          aria-expanded={inboxOpen}
          className={cn(
            'relative rounded-full p-1.5 transition-colors',
            inboxOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
          )}
        >
          <Inbox className="h-4 w-4" />
          {inbox.items.length > 0 ? (
            <span className="bg-foreground text-background absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none">
              {inbox.items.length}
            </span>
          ) : null}
        </button>
      </div>

      {/* Body.
          The overlay panels are siblings of the scroll area rather than
          children of it. As children, `absolute inset-0` resolved against the
          *scrolled content* — so once a competition filled the thread, the
          panel was pinned above the visible region and appeared not to open at
          all. It rendered; it was simply scrolled off screen. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {inboxOpen ? (
          <StandingInboxPanel
            items={inboxItems}
            {...(linkedRuleId !== null ? { focusId: linkedRuleId } : {})}
            onClose={() => setInboxOpen(false)}
            onSign={(item) => {
              // The same path a due rule takes: an ordinary intent the user
              // reviews and signs. The firing decided; this is the trade.
              setInboxOpen(false)
              handleSubmit(
                `Swap ${item.rule.action.amountIn} ${item.rule.action.from} to ${item.rule.action.to}`
              )
            }}
          />
        ) : null}

        {rulesOpen ? (
          <StandingRulesPanel
            rules={standing.rules}
            prices={standing.prices}
            onCancel={standing.cancel}
            onClose={() => setRulesOpen(false)}
            onExecute={(rule) => {
              // A due rule is a decision, not a trade. It becomes an ordinary
              // intent the user reviews and signs — nothing spends money
              // without a signature, which is what makes a browser-side
              // watcher acceptable at all.
              setRulesOpen(false)
              handleSubmit(`Swap ${rule.action.amountIn} ${rule.action.from} to ${rule.action.to}`)
            }}
          />
        ) : null}

        {historyOpen && isConnected ? (
          <ChatHistoryPanel
            turns={turns}
            onSelect={(turn) => {
              // Reopen exactly what was recorded. This used to resubmit the
              // text, which started a fresh competition and produced different
              // answers — the conversation was not being restored at all.
              setHistoryOpen(false)
              setRestored(turn)
              setMessage(turn.text)
              setParsed(parseIntent(turn.text, swap.usdPrices))
              setTurnId(turn.id)
              setExecutingKey(turn.executedBy ?? null)
              setPlacedId(null)
              setPendingInput(null)
              setAffordError(null)
            }}
            onNew={() => {
              // A new conversation, not a replacement. Everything already
              // recorded stays in the list and stays reopenable — the point is
              // to hop between intents, so starting one must never cost you
              // the last.
              setHistoryOpen(false)
              handleReset()
              // Reread rather than trusting local state: the turn just left
              // behind may have gained a hash while it was open.
              setTurns(loadTurns(slug))
            }}
            onClose={() => setHistoryOpen(false)}
            onClear={() => {
              clearTurns(slug)
              setTurns([])
            }}
          />
        ) : null}

        {/* The scrolling thread. Separate from the wrapper above so the
            overlays position against the panel rather than against content
            that moves under them. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* Gated on the message, not on a parsed *trade*.
              `parsed` answers "was a trade read", and three submit paths
              deliberately leave it null: a standing rule, and a supply of
              something already held. Gating the thread on it meant those
              intents set their state correctly, started their work, and
              rendered nothing at all — the empty "say what you want" prompt
              stayed on screen while a supply was built and waiting to sign.
              Even the error message lived in this dead branch, so a failure
              was as invisible as a success. */}
          {!message ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <span className="border-border text-foreground flex h-11 w-11 items-center justify-center rounded-full border">
                <Sparkles className="h-5 w-5" />
              </span>
              <p className="text-muted-foreground max-w-sm text-sm">
                Say what you want to happen. Autonomous agents compete to find the best execution —
                you pick who executes.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* A reopened conversation shows the prices that were quoted when
                it ran. Saying so matters: signing against a rate from an hour
                ago is a different decision from signing a fresh one. */}
              {restored !== null ? (
                <div className="text-muted-foreground flex items-center justify-center gap-2 text-xs">
                  <Clock className="h-3.5 w-3.5" />
                  Reopened from{' '}
                  {new Date(restored.createdAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  <button
                    type="button"
                    onClick={() => handleSubmit(restored.text)}
                    className="hover:text-foreground underline underline-offset-2"
                  >
                    run again
                  </button>
                </div>
              ) : null}

              <div className="flex justify-end">
                <div className="bg-foreground text-background max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm">
                  {message}
                </div>
              </div>
              <CompetitionPanel
                state={competition}
                onExecute={handleExecute}
                executingKey={executingKey}
                locked={
                  swap.phase === 'signing' ||
                  swap.phase === 'submitting' ||
                  swap.phase === 'settled'
                }
              />

              {/* Said before anything is signed. An order the account cannot
                fund is refused here rather than allowed to rest for hours and
                then fail. */}
              {affordError !== null ? (
                <div className="border-border rounded-2xl border border-dashed p-4">
                  <p className="text-foreground text-sm">{affordError}</p>
                </div>
              ) : null}

              {/* A resting order lives in the thread that placed it, with its
                own cancel — the same conversation, not a separate page. */}
              {placedId !== null ? (
                <OpenIntentCard
                  intentId={placedId}
                  onCancel={(id) => cancelIntent.mutate(id)}
                  cancelling={cancelIntent.isPending}
                  cancelError={
                    cancelIntent.isError ? (cancelIntent.error as Error).message : undefined
                  }
                />
              ) : null}

              {/* A limit order goes to the book rather than through a swap, so
                it gets its own card. Both are never active at once: the intent
                is one or the other. */}
              {/* A plan is several actions under one signature, so it gets its
                own card: the ordered list is what the user is approving. */}
              {/* A sequence is several transactions signed one at a time,
                which a plan card must not be used for: it would promise an
                atomicity Soroban cannot give across contract calls. */}
              {/* Read back before anything runs. A parser that reads meaning
                rather than wording handles the many ways people write one
                instruction, and the cost of that flexibility is that its
                confidence is no longer visible in the text. The moment to catch
                a misreading is here, not at the signing card — by then the user
                has waited a minute for agents to argue about a trade that was
                never the one they asked for. */}
              {pending !== null ? (
                <IntentConfirm
                  understood={pending}
                  onConfirm={() => startPending(true)}
                  onReject={() => startPending(false)}
                />
              ) : null}

              {/* The second or two the model takes, said out loud. Silence here
                reads as a dropped intent, which is the complaint that started
                this work. */}
              {parsing && pending === null ? (
                <div className="text-muted-foreground flex items-center gap-2 p-1 text-xs">
                  <Sparkles className="h-3.5 w-3.5" />
                  Reading your intent…
                </div>
              ) : null}

              {/* Supplying what the account already holds. One transaction,
                one signature — no sequence to explain. */}
              {supply.phase !== 'idle' ? <SupplyConfirm supply={supply} /> : null}

              {/* A leveraged position. One transaction, one signature, and a
                liquidation price to read before it. */}
              {perp.phase !== 'idle' ? <PerpConfirm perp={perp} /> : null}

              {sequence.phase !== 'idle' ? <SequenceConfirm sequence={sequence} /> : null}

              {planExec.phase !== 'idle' ? (
                <PlanConfirm
                  plan={planExec}
                  onSettled={(hash) => {
                    if (turnId !== null) {
                      updateTurn(turnId, { txHash: hash })
                      setTurns(loadTurns(slug))
                    }
                  }}
                />
              ) : null}

              {limit.phase !== 'idle' && parsed !== null ? (
                <LimitConfirm
                  order={limit}
                  sellSymbol={parsed.input.tokenIn}
                  buySymbol={parsed.input.tokenOut}
                  onPlaced={(hash) => {
                    // The placing transaction is a real, verifiable event, but it
                    // is not a fill — the order is only now waiting. Recording it
                    // on the conversation lets history link to it without
                    // claiming the trade happened.
                    if (turnId !== null) {
                      updateTurn(turnId, { txHash: hash })
                      setTurns(loadTurns(slug))
                    }

                    // The offer id comes from the ledger rather than the
                    // submission: Horizon reports the placed order on the
                    // account, and reading it back is what makes the recorded id
                    // the one that actually exists.
                    if (placedId !== null && address !== undefined) {
                      void fetch(`/api/offers?account=${encodeURIComponent(address)}`)
                        .then((r) => r.json())
                        .then((body: { offers?: { id: string }[] }) => {
                          const newest = body.offers?.at(-1)
                          if (newest !== undefined) {
                            placeIntent.mutate({
                              id: placedId,
                              offerId: newest.id,
                              txHash: hash,
                            })
                          }
                        })
                        .catch(() => undefined)
                    }
                  }}
                />
              ) : null}

              {/* Everything currently resting, read from the ledger rather than
                remembered here, so a fill that happened elsewhere still shows. */}
              <OpenOrders
                account={slug === 'stellar' ? address : undefined}
                cancelling={limit.phase === 'signing' || limit.phase === 'submitting'}
                onCancel={(offer) => limit.cancel(offer.id, offer.sellingAsset, offer.buyingAsset)}
              />

              {/* Appears only once an agent has won with an executable route, so
                the race is never interrupted by a confirmation prompt.
                Hidden while an order is going to the book: the intent is a
                resting order or an immediate swap, never both, and showing two
                confirmation cards would leave the user to guess which one
                their signature applies to.

                A sequence hides it for the same reason, and the omission was
                visible: a bundled intent showed both a sequence card and a
                plain swap card, each with its own sign button, for the same
                trade. Signing the wrong one would have run the swap alone and
                silently dropped the supply. */}
              <div
                ref={confirmRef}
                hidden={
                  limit.phase !== 'idle' || planExec.phase !== 'idle' || sequence.phase !== 'idle'
                }
              >
                <SwapConfirm
                  phase={swap.phase}
                  quote={swap.quote}
                  sendDisplay={swap.sendDisplay}
                  receiveDisplay={swap.receiveDisplay}
                  hash={swap.hash}
                  explorerUrl={swap.explorerUrl}
                  error={swap.error}
                  usdPrices={swap.usdPrices}
                  preview={swap.preview}
                  agentName={
                    executingKey !== null ? competition.proposals[executingKey]?.name : undefined
                  }
                  sliceCount={
                    executingKey !== null
                      ? competition.proposals[executingKey]?.sliceCount
                      : undefined
                  }
                  horizonMinutes={
                    executingKey !== null
                      ? competition.proposals[executingKey]?.horizonMinutes
                      : undefined
                  }
                  onConfirm={swap.confirm}
                  onReset={swap.reset}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-border shrink-0 border-t p-3">
        <ComposerInput
          onSubmit={handleSubmit}
          showExamples={!parsed}
          {...(parsed ? { onReset: handleReset } : {})}
        />
        {createIntent.isError ? (
          <p className="text-foreground mt-2 text-xs">
            {(createIntent.error as Error).message || 'Something went wrong. No funds moved.'}
          </p>
        ) : null}
      </div>
    </div>
  )
}
