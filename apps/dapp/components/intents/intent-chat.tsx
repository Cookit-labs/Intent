'use client'

import { cn } from '@intent/ui'
import { activeNetwork, isMainnet, stellarNetwork } from '@intent/config'
import { motion } from 'framer-motion'
import Image from 'next/image'
import { CheckCheck, Clock, Plus, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useChain } from '../../providers/chain-provider'
import { useCompetition } from '../../hooks/use-competition'
import { classifyFollowUp, raceContext, type ThreadTurn } from '../../lib/chat/thread'
import { fetchOrchestrate, type ActReading } from '../../lib/chat/orchestrate-client'
import {
  balanceMessage,
  helpMessage,
  outOfScopeMessage,
  unavailableMessage,
  unclearMessage,
} from '../../lib/chat/orchestrate-copy'
import { rememberExchange } from '../../lib/chat/dialogue'
import {
  appendLiveTurn,
  cardIsStale,
  chainOutcomeSentence,
  clearLiveSession,
  FINISH_SIGNATURE_NOTICE,
  liveSessionStorage,
  loadLiveSession,
  ownedTurns,
  ownerChange,
  recordableReply,
  WALLET_SWITCHED_NOTICE,
  type LiveTurn,
} from '../../lib/chat/live-session'
import { fixVerbTypo } from '../../lib/chat/typos'
import { StrategyEditor, type StrategyEdits } from './strategy-editor'
import { DEFAULT_SLIPPAGE_BPS } from '../../lib/swap/build-tx'
import { ACKNOWLEDGED } from '../../lib/chat/clarify-flow'
import type { ClarifyTurn } from '../../lib/clarify/clarify'
import {
  chainReviewClosed,
  raceClosed,
  stepErrorMessage,
  chainSigning,
  isChainRoute,
  canReview,
  needsDirectRoute,
  reviewChainRoute,
  routeForSwap,
  selectionHolds,
  showDirectNote,
} from '../../lib/agents/chain-race'
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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { OpenIntentCard } from './open-intent-card'
import { NairaOrderTracker, NairaPayoutCard } from './naira-payout-card'
import {
  detectPayout,
  namedPayoutAsset,
  readPayoutSource,
  unsupportedCurrencyMessage,
} from '../../lib/naira/currency'
import { ChatHistoryPanel } from './chat-history-panel'
import { StandingRulesPanel } from './standing-rules-panel'
import { StandingInboxPanel } from './standing-inbox-panel'
import { useStandingRules } from '../../hooks/use-standing-rules'
import { useStandingInbox } from '../../hooks/use-standing-inbox'
import { ensureSession } from '../../lib/api/auth'
import { balanceReplyDecision, chainBalanceReply } from '../../lib/chains/balance-reply'
import { chainCapabilities } from '../../lib/chains/capabilities'
import { sizeInUnits } from '../../lib/chains/dollar-amount'
import { chainHelp, helpForUnread } from '../../lib/chains/explain'
import { racesFirst } from '../../lib/chains/parse-action'
import { asksForPositions, readPositionsReply } from '../../lib/chains/positions-reply'
import {
  cashoutStarts,
  chainRouteFromReading,
  messageStartsAction,
  readChainMessage,
} from '../../lib/chains/parse-sequence'
import { followOnRefusal, type ChainSequenceRequest } from '../../lib/chains/sequence'
import {
  CASHOUT_UNDER_WAY,
  cashoutSequence,
  currencyStep,
  endedNote,
  keepsRun,
  questionAnswerFrom,
  questionChainRefusal,
  sequenceOutcome,
  stepOnItsOwn,
  readFollowOnPlan,
  cashoutSaid,
} from '../../lib/chains/sequence-flow'
import type { ChainActionRequest, ChainWithActions, WalletBalances } from '../../lib/chains/types'
import { QUOTE_EXPIRED } from '../../lib/chains/signing-flow'
import { useChainAction } from '../../hooks/use-chain-action'
import { useChainSequence } from '../../hooks/use-chain-sequence'
import { ChainActionConfirm } from './chain-action-confirm'
import { ChainSequenceSteps } from './chain-sequence-steps'
import { fetchCashoutCurrencies, useCashout } from '../../hooks/use-cashout'
import { CashoutCard } from './cashout-card'
import { CashoutCurrencyQuestion, type CashoutQuestionState } from './cashout-currency-question'
import {
  cashoutChoices,
  CURRENCY_QUESTION,
  NO_CASHOUTS,
  unsupportedCurrencyReply,
  unsupportedTokenReply,
} from '../../lib/weave/cashout-view'
import {
  parseCashout,
  parseCurrencyAnswer,
  routeCashout,
  type CashoutCurrencyCode,
  type CashoutRoute,
} from '../../lib/weave/parse-cashout'
import {
  cashoutFormOutcome,
  cashoutOutcome,
  cashoutTurns,
  fetchCashouts,
} from '../../lib/naira/history'
import { fetchSwapHistory } from '../../lib/swap/history'
import { ledgerTurns } from '../../lib/chat/ledger-turns'
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
import { buildParsedIntent, parseIntent, type ParsedIntent } from '../../lib/parse-intent'
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
import { parseSendIntent } from '../../lib/parse-send'
import { classifyAnchorAnswer } from '../../lib/offramp/anchor-answer'
import type { AnchorId } from '../../lib/offramp/anchors'
import { isAnchorId } from '../../lib/offramp/anchors'
import type { WithdrawLimits } from '../../lib/offramp/sep24'
import { estimatedReceiveOf } from '../../lib/offramp/labels'
import { useSupply } from '../../hooks/use-supply'
import { SupplyConfirm } from './supply-confirm'
import { useBorrow } from '../../hooks/use-borrow'
import { useWithdraw } from '../../hooks/use-withdraw'
import { BorrowConfirm } from './borrow-confirm'
import { WithdrawConfirm } from './withdraw-confirm'
import { usePerp } from '../../hooks/use-perp'
import { PerpConfirm } from './perp-confirm'
import { parsePerpIntent } from '../../lib/parse-perp'
import {
  registerLiveAsset,
  tradeableSymbols,
  type VerifiedAsset,
} from '../../lib/swap/asset-registry'
import { parseStellarExit, whereReply, type StellarExit } from '../../lib/lend/parse-exit'
import type { BlendPositions } from '../../lib/lend/position'
import { suppliableReserve } from '../../lib/lend/reserves'
import { lendingVenueName } from '../../lib/lend/venues'
import { ChainOrdersCard } from './chain-orders-card'
import { IntentConfirm, type UnderstoodIntent } from './intent-confirm'
import { resolveAsset, toBaseUnits } from '../../lib/swap/assets'
import { toPriceFraction } from '../../lib/swap/limit-price'
import { LimitConfirm } from './limit-confirm'
import { OpenOrders } from './open-orders'
import { ComposerInput } from './composer-input'
import { NativeCoinTicker } from './native-coin-ticker'
import { PriceTicker } from './price-ticker'
import { agentBubble, systemPill, userBubble } from './bubble'
import { AgentAvatar } from '../agents/agent-avatar'
import {
  clearPendingCashOut,
  pendingCashOut,
  setPendingCashOut,
  type PendingCashOut,
} from '../../lib/pending-cashout'

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

/** The asset a cash-out form pays out, as the form names it. */
function nairaSymbol(form: { asset: 'xlm' | 'usdc'; symbol?: string }): string {
  return form.symbol ?? (form.asset === 'usdc' ? 'USDC' : 'XLM')
}

/** Who the user is talking to, the way a chat app heads a conversation. */
function ChatIdentity(): JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span className="bg-brand relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
        <Image
          src="/images/intent-logo.png"
          alt="Intent"
          width={512}
          height={361}
          className="h-[15px] w-auto invert"
        />
        <span className="border-card bg-success absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2" />
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-foreground text-sm font-semibold">Agent network</span>
        <span className="text-muted-foreground text-[11px]">Live settlement</span>
      </div>
    </div>
  )
}

/** What was said before this page was opened: words and a link, nothing to press or sign. */
function SavedTurns({ turns }: { turns: LiveTurn[] }): JSX.Element {
  return (
    <>
      {turns.map((turn, i) => (
        <div
          key={`${turn.at}-${i}`}
          className={cn('flex', turn.role === 'user' ? 'justify-end' : 'justify-start')}
        >
          <div className={turn.role === 'user' ? userBubble : agentBubble}>
            {turn.text}
            {turn.explorerUrl !== undefined ? (
              <a
                href={turn.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block text-xs underline underline-offset-2 opacity-70"
              >
                View transaction
              </a>
            ) : null}
          </div>
        </div>
      ))}
    </>
  )
}

export function IntentChat({
  showing,
  linkedRule,
}: {
  /** False while the person is on another page and this is kept mounted behind it. */
  showing: boolean
  linkedRule?: string
}): JSX.Element {
  const createIntent = useCreateIntent()
  const cancelIntent = useCancelIntent()
  const settleIntent = useSettleIntent()
  const placeIntent = usePlaceIntent()
  const [message, setMessage] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedIntent | null>(null)
  const [executingKey, setExecutingKey] = useState<string | null>(null)
  // A swap, supply or stake typed on a chain other than Stellar, while its race
  // runs. `parsed` stays null for it so Stellar's cards do not appear.
  const [chainRace, setChainRace] = useState<{ request: ChainActionRequest; text: string } | null>(
    null
  )
  // Set when the race left nothing to review and the direct route was built, so
  // the card can say why.
  const [directFallback, setDirectFallback] = useState(false)
  // The intent placed in this conversation, so an order that is waiting for a
  // price can be watched — and withdrawn — without leaving the chat.
  const [placedId, setPlacedId] = useState<string | null>(null)
  const [affordError, setAffordError] = useState<string | null>(null)
  // The naira cash-out form, dropped into the thread only once an instruction
  // has been read as one. The counter gives each ask a fresh form.
  const [nairaForm, setNairaForm] = useState<{
    key: number
    path: 'xlm' | 'usdc'
    /** What is paid out: XLM, or USDC that is already held. */
    asset: 'xlm' | 'usdc'
    /** A verified asset other than XLM or USDC, converted to USDC before the payout. */
    symbol?: string
    amountXlm?: number
  } | null>(null)
  // The bank details of a convert-first payout, held only until the swap is
  // chosen and signed. In memory: never in history, storage or the URL.
  // A cash-out of anything but USDC: the agents race on the swap into USDC
  // first, and the payout form opens only once that swap has settled.
  const [cashOutAfterSwap, setCashOutAfterSwap] = useState(false)
  // A swap that settled meaning to be followed by a cash-out, where the tab
  // closed (or the user navigated away) before that second step ever
  // started. Read once per wallet, not kept in sync with cashOutFrom below:
  // this exists for the gap *before* that state exists, not alongside it.
  const [strandedCashOut, setStrandedCashOut] = useState<PendingCashOut | undefined>(undefined)
  // The settled swap a cash-out continues from, kept apart from the swap card
  // so its Done button, or any reset of the card, cannot take the form away.
  const [cashOutFrom, setCashOutFrom] = useState<{ hash: string; receive: string } | null>(null)
  const queryClient = useQueryClient()
  const [nairaConvert, setNairaConvert] = useState<{
    bankCode: string
    accountNumber: string
  } | null>(null)
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
  // Messages that were answered rather than run, with the replies given. Sent
  // with the next message so the model answers in the flow of the conversation.
  const dialogue = useRef<ClarifyTurn[]>([])
  // Where the chat is now, read after a slow answer to tell whether it is still wanted.
  const latest = useRef({ chain: '', account: undefined as string | undefined, turn: 0 })
  // Clarify calls still waiting on an answer. The wait is over only when none are.
  const clarifyRuns = useRef(0)

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

  // From the address, and read again when it changes: the chat stays mounted
  // across pages, so a link can arrive long after it first rendered.
  useEffect(() => {
    openedFromLink.current = false
    setLinkedRuleId(linkedRule !== undefined && linkedRule !== '' ? linkedRule : null)
  }, [linkedRule])

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
  /** The message that asked for the resting limit orders, while their list is on screen. */
  const [ordersShown, setOrdersShown] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  // The conversation around the open intent. `thread` holds the turns that came
  // before it, kept in view so the chat reads as one; `notes` are things the
  // user added to the open intent while it was still being decided, which
  // every agent is given on a re-run.
  const [thread, setThread] = useState<ThreadTurn[]>([])
  const [notes, setNotes] = useState<string[]>([])
  // A question put to the user before any agent runs. While set, the next
  // message is the answer to it, not a new instruction.
  const [clarifying, setClarifying] = useState<{ turns: ClarifyTurn[] } | null>(null)
  const [clarifyBusy, setClarifyBusy] = useState(false)
  // What the questions established, handed to every agent unchanged.
  const [brief, setBrief] = useState<string[]>([])
  // What the user changed about how the recommendation is carried out. Per
  // turn: a new intent starts from the agents' own proposal again.
  const [strategy, setStrategy] = useState<StrategyEdits>({})
  const slippageEdit =
    strategy.slippageBps !== undefined ? { slippageBps: strategy.slippageBps } : {}

  const { slug, segment, descriptor } = useChain()
  const { address, isConnected } = useWallet()
  latest.current.chain = slug
  latest.current.account = address

  // What was said here before a reload. Read while no thread is open, which is
  // also what keeps a wallet's own words from showing twice, and shown under the
  // account it was read for only. Writing it never touches saveTurn.
  const [savedTurns, setSavedTurns] = useState<{ account: string; turns: LiveTurn[] } | null>(null)
  const transcriptOwner = isConnected ? address : undefined
  // Whose chat is on screen, which is who it is recorded for. Differs from the
  // connected wallet only while a switch waits on an open signature.
  const chatOwner = useRef(transcriptOwner)
  const transcript = restored === null ? ownedTurns(savedTurns, transcriptOwner) : []
  // Earlier turns and notes kept for the agents, already shown among the saved turns.
  const [inSaved, setInSaved] = useState({ thread: 0, notes: 0 })
  useEffect(() => {
    setSavedTurns(
      transcriptOwner !== undefined && message === null && thread.length === 0
        ? {
            account: transcriptOwner,
            turns: loadLiveSession(liveSessionStorage(), segment, transcriptOwner),
          }
        : null
    )
    // Only a new wallet or chain reads again; a thread opening must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, transcriptOwner])

  function recordLive(
    role: LiveTurn['role'],
    text: string,
    explorerUrl?: string,
    account: string | undefined = chatOwner.current
  ): void {
    if (account === undefined) return
    appendLiveTurn(liveSessionStorage(), segment, account, {
      role,
      text,
      at: Date.now(),
      ...(explorerUrl !== undefined ? { explorerUrl } : {}),
    })
  }

  // One line per transaction, however many times its state is rendered or reported.
  const recordedHashes = useRef(new Set<string>())
  function recordSettled(
    text: string,
    hash: string | undefined,
    explorerUrl: string | undefined
  ): void {
    if (hash === undefined || recordedHashes.current.has(hash)) return
    recordedHashes.current.add(hash)
    recordLive('agent', text, explorerUrl)
  }

  // Checked once the wallet that owns it is known — historyOwner, which
  // pendingCashOut reads, is set from this same address elsewhere — so a
  // reminder left by a different wallet in this browser is never shown
  // under the wrong one.
  useEffect(() => {
    setStrandedCashOut(isConnected ? pendingCashOut() : undefined)
  }, [isConnected, address])
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
      // Deliberately no ledger backfill: the account's ledger holds every swap
      // from every app, and importing them listed other apps' trades here as
      // Intent conversations. The History tab reads the ledger for that.
      setTurns(fromServer)
    }

    void load().catch(() => {
      // Both halves already degrade on their own; a failure here must not
      // empty a history panel that has perfectly good cached rows.
    })

    return () => {
      cancelled = true
    }
  }, [slug, address])

  const { data: cashouts } = useQuery({
    queryKey: ['cashouts', address],
    queryFn: () => fetchCashouts(address as string),
    enabled: slug === 'stellar' && isConnected && address !== undefined,
    staleTime: 30_000,
  })
  const { data: ledger } = useQuery({
    queryKey: ['swap-history', slug, address],
    queryFn: () => fetchSwapHistory(address as string),
    enabled: slug === 'stellar' && isConnected && address !== undefined,
    staleTime: 30_000,
  })
  const listedTurns = useMemo(() => {
    const have = new Set(
      turns.flatMap((t) => [
        ...(t.txHash === undefined ? [] : [t.txHash]),
        ...(t.bundle ?? []).flatMap((s) => (s.hash === undefined ? [] : [s.hash])),
      ])
    )
    const cashoutRows = cashoutTurns(cashouts ?? [], slug, have)
    for (const row of cashoutRows) if (row.txHash !== undefined) have.add(row.txHash)
    return [...turns, ...cashoutRows, ...ledgerTurns(ledger ?? [], slug, have)].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    )
  }, [turns, cashouts, ledger, slug])

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
  const live = useCompetition(
    restored === null ? parsed : null,
    slug,
    chainRace !== null ? [] : [...raceContext(thread, notes), ...brief],
    address,
    restored === null && chainRace !== null ? chainRace : undefined
  )
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
          ...(restored.talk !== undefined
            ? { thread: restored.talk.thread, takes: restored.talk.takes }
            : {}),
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
    // A chain route never reaches the Stellar swap hook: it has no sendAmount,
    // and would be read as a Stellar quote.
    return routeForSwap(routesByAgent[executingKey] ?? winnerRoute)
  }, [executingKey, routesByAgent, winnerRoute])

  const swap = useSwapExecution(chosenRoute, strategy.slippageBps)

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
  // Money coming back out, typed rather than pressed. Their own hooks: these never run beside a trade.
  const exitWithdraw = useWithdraw()
  const exitRepay = useBorrow()
  const chainAction = useChainAction()
  // A new race gets a clean slate when the chain changes.
  useEffect(() => {
    clearChainRace()
    chainAction.release()
    chainAction.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])
  // Selected is shown only while a build or its aftermath is live; a failed
  // build must not leave an agent looking chosen.
  useEffect(() => {
    if (chainRace !== null && !selectionHolds(chainAction.phase)) setExecutingKey(null)
  }, [chainRace, chainAction.phase])
  const chainConfirmRef = useRef<HTMLDivElement | null>(null)
  const chainAwaiting = chainAction.phase === 'review'
  useEffect(() => {
    if (!chainAwaiting) return
    chainConfirmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [chainAwaiting])
  // The race ended with nothing to review: build the direct route once, so the
  // chain keeps working when the agents are offline. A refusal of the action
  // is shown as written by the card and is not retried.
  const fellBackRef = useRef<typeof chainRace>(null)
  // The race the hook has actually begun. On the render where a new race is
  // asked for, the hook still holds the last one's ending, which must not be
  // mistaken for this race's.
  const startedRef = useRef<typeof chainRace>(null)
  const raceEnded = needsDirectRoute({
    phase: live.phase,
    winner: live.winner,
    anyAnswered: Object.values(live.proposals).some((p) => p.failed === undefined),
    ...(live.error !== undefined ? { error: live.error } : {}),
  })
  useEffect(() => {
    if (chainRace === null || restored !== null || fellBackRef.current === chainRace) return
    // The swap this race was for has settled, so nothing more is built from it.
    if (chainSequence.settled) return
    if (live.phase === 'competing') startedRef.current = chainRace
    if (startedRef.current !== chainRace) return
    if (live.error?.code === 'action_refused') {
      fellBackRef.current = chainRace
      chainAction.refuse(live.error.message, chainRace.text)
      return
    }
    if (!raceEnded) return
    fellBackRef.current = chainRace
    setDirectFallback(true)
    chainAction.prepare(chainRace.request, chainRace.text)
    // chainAction changes identity with its state; the race ending is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainRace, raceEnded, live.error, live.phase, restored])
  const cashout = useCashout()
  const [cashoutQuestion, setCashoutQuestion] = useState<CashoutQuestionState | null>(null)
  // A swap and what follows it, on a chain with its own module. Step 1 is the race above.
  const chainSequence = useChainSequence(chainAction, cashout)
  // Read when a model's answer comes back, which may be after the run has moved on.
  const chainSequenceNow = useRef(chainSequence)
  chainSequenceNow.current = chainSequence
  // The run whose step 2 now waits for a press, because the person left or typed during it.
  const autoStoppedFor = useRef<ChainSequenceRequest | null>(null)
  // What a new message left behind by ending a swap that had settled.
  const [sequenceNote, setSequenceNote] = useState<string | null>(null)
  useEffect(() => {
    chainSequence.clear()
    setSequenceNote(null)
    // A question asked on the last chain can't start anything on this one.
    setCashoutQuestion(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])
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
  // A send-only run is the same: no trade, `parsed` null, and a payment that
  // really settled must still reach history.
  const sequenceKind = sequence.kind
  useEffect(() => {
    if (sequenceHash === undefined) return
    if (parsed === null && sequenceKind !== 'offramp-only' && sequenceKind !== 'send-only') return

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

  // A failed swap keeps its agent selected so the failure stays on screen.
  // Clearing the selection here used to empty the route, which reset the swap
  // and wiped the error within a frame. The cards only lock while a signature
  // is in flight, so every agent is pickable again after a failure anyway;
  // Try again and Cancel release the selection (`releaseSwap`).
  function releaseSwap(): void {
    swap.reset()
    setExecutingKey(null)
  }

  useEffect(() => {
    setTurns(loadTurns(slug))
  }, [slug, address])

  // What the assistant says outside a race — an answer, a refusal, an error —
  // is the reply to the turn, and is kept with it. Only the race and a placed
  // cash-out used to be written, so reopening anything else showed the user's
  // line with nothing under it.
  useEffect(() => {
    if (affordError === null || turnId === null || message === null || restored !== null) return
    updateTurn(turnId, { outcome: affordError }, { chain: slug, text: message })
    setTurns(loadTurns(slug))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [affordError])

  // An opened cash-out form is a reply too. An order placed from it replaces
  // this with how the payout went.
  const nairaFormKey = nairaForm?.key
  useEffect(() => {
    if (nairaForm === null || turnId === null || message === null || restored !== null) return
    updateTurn(
      turnId,
      { outcome: cashoutFormOutcome(nairaSymbol(nairaForm), nairaForm.amountXlm) },
      { chain: slug, text: message }
    )
    setTurns(loadTurns(slug))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nairaFormKey])

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
      ...((live.thread ?? []).some((i) => i.type === 'line' && i.line.kind !== 'turn')
        ? { talk: { thread: live.thread ?? [], takes: live.takes ?? {} } }
        : {}),
    })
    setTurns(loadTurns(slug))
    // Keyed on the decision, not on the proposals object, which is rebuilt on
    // every frame of the reveal animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decided, turnId, message, slug])

  // The transcript, as things are said and settle. Words and links only: a label
  // or a card's figures come from what is signed, so none of them are kept.
  useEffect(() => {
    if (
      affordError !== null &&
      message !== null &&
      restored === null &&
      recordableReply(affordError)
    ) {
      recordLive('agent', affordError)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [affordError])

  // A chain race leaves one sentence, below, and none of its agents' reasoning.
  const raceWinner = liveCompetition.winner
  const raceReply =
    restored !== null || chainRace !== null
      ? undefined
      : decided && raceWinner !== null
        ? liveCompetition.proposals[raceWinner]?.reasoning
        : live.error?.message
  useEffect(() => {
    if (raceReply !== undefined && raceReply !== '' && message !== null) {
      recordLive('agent', raceReply)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceReply])

  const typedStep =
    chainSequence.sequence === null ? undefined : stepOnItsOwn(chainSequence.sequence)
  const chainOutcome = chainOutcomeSentence({
    phase: chainAction.phase,
    venueName: chainAction.prepared?.venueName,
    error: stepErrorMessage(chainAction.error, chainSequence.settled, typedStep),
  })
  useEffect(() => {
    if (chainOutcome === undefined || message === null) return
    // To the wallet that signed it, should another have connected since.
    recordLive(
      'agent',
      chainOutcome,
      chainAction.phase === 'settled' ? chainAction.explorerUrl : undefined,
      chainAction.account ?? chatOwner.current
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainOutcome])

  const sequenceLine = sequenceOutcome(
    chainSequence.stage,
    chainSequence.delivered,
    chainSequence.error,
    chainSequence.sequence ?? undefined
  )
  // Leaving the form brings `ready` back, and what arrived was said the first time.
  const deliveredRecordedFor = useRef<ChainSequenceRequest | null>(null)
  useEffect(() => {
    if (sequenceLine === undefined) return
    if (chainSequence.stage === 'ready') {
      if (deliveredRecordedFor.current === chainSequence.sequence) return
      deliveredRecordedFor.current = chainSequence.sequence
    }
    recordLive(
      'agent',
      sequenceLine,
      undefined,
      chainSequence.account ?? chainAction.account ?? chatOwner.current
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequenceLine])

  useEffect(() => {
    recordSettled('The swap settled.', settledHash, swap.explorerUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledHash])
  useEffect(() => {
    const total = sequence.steps.length
    sequence.steps.forEach((step, i) => {
      recordSettled(
        total === 1 ? 'The transaction settled.' : `Step ${i + 1} of ${total} settled.`,
        step.hash,
        step.explorerUrl
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequenceSteps])
  const supplyHash = supply.phase === 'settled' ? supply.hash : undefined
  useEffect(() => {
    recordSettled('The supply settled.', supplyHash, supply.explorerUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplyHash])
  const exitWithdrawHash = exitWithdraw.phase === 'settled' ? exitWithdraw.hash : undefined
  useEffect(() => {
    recordSettled('The withdrawal settled.', exitWithdrawHash, exitWithdraw.explorerUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitWithdrawHash])
  const exitRepayHash = exitRepay.phase === 'settled' ? exitRepay.hash : undefined
  useEffect(() => {
    recordSettled('The repayment settled.', exitRepayHash, exitRepay.explorerUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitRepayHash])
  const perpHash = perp.phase === 'settled' ? perp.hash : undefined
  useEffect(() => {
    recordSettled('The position opened.', perpHash, perp.explorerUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perpHash])
  useEffect(() => {
    recordSettled('The cash-out payment was sent.', cashout.hash, cashout.explorerUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashout.hash])

  /** A settled Stellar transaction known only by its hash. */
  function recordStellarTx(text: string, hash: string | undefined): void {
    recordSettled(text, hash, `${stellarNetwork.blockExplorerUrl}/tx/${hash}`)
  }

  // The USDC the swap delivered is read from the account, so the balance is
  // refreshed the moment the swap settles.
  const swapSettled = swap.phase === 'settled'
  useEffect(() => {
    if (!swapSettled || !cashOutAfterSwap || address === undefined) return
    const settled = { hash: swap.hash ?? '', receive: swap.receiveDisplay ?? '' }
    // Marked the instant the swap is known to owe a cash-out, not after the
    // form opens: if the tab closes during the balance refetch below, the
    // swap already settled and the reminder must already exist to find it.
    setPendingCashOut(settled.hash, settled.receive)
    // The form opens once the balance has been read again, so it starts from
    // the USDC that arrived rather than a figure from before the swap.
    void queryClient
      .refetchQueries({ queryKey: ['stellar-balances', address] })
      .finally(() => setCashOutFrom(settled))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapSettled, cashOutAfterSwap])
  const usdcHeld = balances?.trustlines?.['USDC']?.balance
  // The form appears below a long thread, so it is brought into view rather
  // than left for the user to find by scrolling.
  const cashOutRef = useRef<HTMLDivElement>(null)
  const cashOutShown = cashOutFrom !== null
  useEffect(() => {
    if (!cashOutShown) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const id = window.setTimeout(() => {
      cashOutRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    }, 150)
    return () => window.clearTimeout(id)
  }, [cashOutShown])
  // What the payout opens on: what the swap said it would deliver, never more
  // than the account now holds.
  const cashOutUsdc =
    cashOutFrom === null || cashOutFrom.receive === ''
      ? undefined
      : Math.floor(
          Math.min(
            Number(cashOutFrom.receive),
            usdcHeld !== undefined ? Number(usdcHeld) : Number.POSITIVE_INFINITY
          ) * 100
        ) / 100

  /** A signature is with the wallet or the network, so nothing may change under it. */
  const executionInFlight =
    swap.phase === 'signing' ||
    swap.phase === 'submitting' ||
    sequence.phase === 'signing' ||
    sequence.phase === 'submitting' ||
    exitWithdraw.phase === 'signing' ||
    exitWithdraw.phase === 'submitting' ||
    exitRepay.phase === 'signing' ||
    exitRepay.phase === 'submitting' ||
    chainSigning(chainAction.phase)

  // Declared after the effects that record, so a transaction settling in the same
  // render as a switch is written to the wallet that signed it, before the reset.
  // A sequence with a step settled and the next unsigned counts as open: resetting
  // would lose the only way to finish it. So does a chain swap still being measured.
  // Off Stellar the wait ends when the signature does, or the measure: the reset below
  // then ends the run, whether the swap just settled or reached `ready`. The new wallet
  // is offered no step 2, and the outcome goes to the transcript of the wallet that signed.
  const signatureOpen =
    executionInFlight ||
    cashout.locked ||
    chainSequence.stage === 'measuring' ||
    (sequence.phase !== 'settled' && sequence.steps.some((step) => step.hash !== undefined))
  useEffect(() => {
    const change = ownerChange(chatOwner.current, transcriptOwner, signatureOpen)
    if (change === 'defer') {
      setAffordError(WALLET_SWITCHED_NOTICE)
      return
    }
    if (change === 'keep') {
      if (transcriptOwner !== undefined) chatOwner.current = transcriptOwner
      setAffordError((e) => (e === WALLET_SWITCHED_NOTICE ? null : e))
      return
    }
    leaveSequence()
    clearOpenChat()
    // None of what follows is cleared by New chat, and all of it is the last wallet's.
    dialogue.current = []
    setPending(null)
    supply.reset()
    exitWithdraw.reset()
    exitRepay.reset()
    perp.reset()
    planExec.reset()
    limit.reset()
    chainAction.reset()
    setHistoryOpen(false)
    setRulesOpen(false)
    setInboxOpen(false)
    chatOwner.current = transcriptOwner
    setSavedTurns(
      transcriptOwner === undefined
        ? null
        : {
            account: transcriptOwner,
            turns: loadLiveSession(liveSessionStorage(), segment, transcriptOwner),
          }
    )
    // Runs on a new wallet, and again when the signature it was waiting on ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptOwner, signatureOpen])

  // Coming back to a card left open. A chain's card or a position holds what was
  // built when it was shown, and not every one is refused later: NEAR's wallet sends
  // for itself with no check of the deadline. A Stellar swap is rebuilt and aged by
  // the server at signing, and its other envelopes lapse on the network, so neither
  // is touched here.
  const chainCardShownAt = useRef(0)
  useEffect(() => {
    chainCardShownAt.current = Date.now()
  }, [chainAction.prepared])
  const perpCardShownAt = useRef(0)
  useEffect(() => {
    perpCardShownAt.current = Date.now()
  }, [perp.xdr])
  const wasShowing = useRef(showing)
  useEffect(() => {
    const cameBack = showing && !wasShowing.current
    wasShowing.current = showing
    if (!cameBack) return
    const now = Date.now()
    const deadline = chainAction.prepared?.context?.['deadline']
    if (
      chainAction.phase === 'review' &&
      cardIsStale(
        {
          ...(deadline !== undefined ? { deadline } : {}),
          shownAt: chainCardShownAt.current,
        },
        now
      )
    ) {
      chainAction.refuse(QUOTE_EXPIRED, chainAction.asked ?? message ?? '')
    }
    if (perp.phase === 'review' && cardIsStale({ shownAt: perpCardShownAt.current }, now)) {
      perp.reset()
      setAffordError(QUOTE_EXPIRED)
    }
    // Only the moment of coming back decides this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing])

  /** Something came of the open intent: a trade settled, or an order was placed. */
  const turnExecuted = swap.phase === 'settled' || sequence.phase === 'settled' || placedId !== null

  /** What was said back to the open turn, in the words it was shown. */
  function openTurnReply(): ThreadTurn['reply'] {
    if (affordError !== null) return { text: affordError }
    if (nairaForm !== null) {
      return { text: cashoutFormOutcome(nairaSymbol(nairaForm), nairaForm.amountXlm) }
    }
    const chosen = executingKey ?? competition.winner
    const proposal = chosen !== null ? competition.proposals[chosen] : undefined
    if (proposal?.reasoning !== undefined && proposal.reasoning !== '') {
      return { text: proposal.reasoning, agentKey: proposal.key, agentName: proposal.name }
    }
    if (restored?.outcome !== undefined) return { text: restored.outcome }
    return undefined
  }

  /** Puts the open turn behind the user, so the next one reads as the chat's next line. */
  function archiveOpenTurn(): void {
    if (message === null) return
    const previous = message
    const reply = openTurnReply()
    setThread((t) => [
      ...t,
      {
        id: turnId ?? crypto.randomUUID(),
        text: previous,
        executed: turnExecuted,
        attempted: parsed !== null || nairaForm !== null || sequence.phase !== 'idle',
        ...(reply !== undefined ? { reply } : {}),
      },
    ])
    setNotes([])
  }

  /** Ends a chain race and what hangs off it; the direct-route note belongs to the race. */
  function clearChainRace(): void {
    setChainRace(null)
    setDirectFallback(false)
  }

  /** What a previous attempt left on screen, which a new turn must not inherit. */
  function resetTurnState(): void {
    clearChainRace()
    sequence.reset()
    swap.reset()
    supply.reset()
    exitWithdraw.reset()
    exitRepay.reset()
    perp.reset()
    setExecutingKey(null)
    setPlacedId(null)
    setAffordError(null)
    setNairaForm(null)
    setNairaConvert(null)
    setCashOutAfterSwap(false)
    setCashOutFrom(null)
    setPendingInput(null)
    setFollowOn(null)
    setHistoryOpen(false)
    setRestored(null)
    setPending(null)
    setBrief([])
    setStrategy({})
  }

  /**
   * Runs an instruction: the standing-rule check, the payout form, the parsers
   * and the race.
   *
   * `continuing` is set when a question was asked first and the answers have
   * made this the same turn, so it is neither a note nor a new line of the
   * chat. `shown` is what the user typed, which stays in the bubble even when
   * the instruction that runs is the clarifier's rewrite of it.
   */
  /**
   * Cashes out an asset that Linq cannot take: race the swap into USDC now,
   * and open the payout form once it settles, sized to what arrived. Bank
   * details are asked for after the swap, never held through it.
   */
  function startSwapThenCashOut(symbol: string, amount: number | undefined): void {
    if (amount === undefined || !(amount > 0)) {
      setAffordError(
        `How much ${symbol} do you want to cash out? For example: cash out 20 ${symbol} to naira.`
      )
      return
    }
    setCashOutAfterSwap(true)
    // Replaces the reader's notes about the bank: given those, agents judged
    // the swap against a payout they cannot see and called it impossible.
    setBrief([
      `This swap is step one of a naira cash-out. The USDC it delivers is paid to a Nigerian bank by Linq in a separate step after it settles. Your job is only the best ${symbol} to USDC swap.`,
    ])
    setParsed(parseIntent(`Swap ${amount} ${symbol} to USDC`, swap.usdPrices))
  }

  /**
   * Opens the cash-out form for a swap that already settled, left behind by
   * a closed tab. The swap itself needs nothing re-run — it is already in
   * history — so this only starts a turn to hold the payout and shows the
   * form, the same state `cashOutAfterSwap`'s settle effect would have
   * reached if the tab had stayed open.
   */
  function resumeStrandedCashOut(stranded: PendingCashOut): void {
    const newTurnId = crypto.randomUUID()
    const text = `Cash out ${stranded.receiveDisplay} USDC to naira`
    setTurnId(newTurnId)
    setMessage(text)
    setCashOutFrom({ hash: stranded.swapHash, receive: stranded.receiveDisplay })
    setStrandedCashOut(undefined)
    recordLive('user', text)
    saveTurn({
      id: newTurnId,
      chain: slug,
      text,
      createdAt: new Date().toISOString(),
      proposals: {},
      winner: null,
      txHash: stranded.swapHash,
    })
    setTurns(loadTurns(slug))
  }

  function startIntent(
    text: string,
    options: {
      shown?: string
      brief?: string[]
      continuing?: boolean
      conversation?: ClarifyTurn[]
      /** The orchestrator's structured reading of `text`, when it is the one that wrote it. */
      reading?: ActReading
    } = {}
  ): void {
    const continuing = options.continuing === true
    const shown = options.shown ?? text

    // While an intent is open and unexecuted, a message that only adjusts it is
    // a note: the agents are given it and race again, instead of the chat
    // starting over and discarding what they said.
    if (!continuing && message !== null && parsed !== null && restored === null && !turnExecuted) {
      if (classifyFollowUp(text) === 'note') {
        if (executionInFlight) {
          setAffordError(FINISH_SIGNATURE_NOTICE)
          return
        }
        setNotes((n) => [...n, text])
        setExecutingKey(null)
        swap.reset()
        sequence.reset()
        setAffordError(null)
        return
      }
    }

    // Anything else is a new turn. The one before it stays in view, so a
    // follow-up after a trade reads as the next line of the same chat.
    if (!continuing) archiveOpenTurn()
    setBrief(options.brief ?? [])
    setStrategy({})

    // A rule is not a trade. "Buy XLM if it drops to $0.16" describes when to
    // act, and running a competition on it now would execute at a price the
    // user explicitly said they did not want.
    //
    // Anything expressible as a resting order is deliberately *not* caught
    // here — the parser declines it, so it becomes a real order on Stellar's
    // book rather than a promise this app has to stay open to keep.
    const rule = parseStandingIntent(text, swap.usdPrices ?? {}, slug)
    if (rule !== null) {
      saveTurn({
        id: crypto.randomUUID(),
        chain: slug,
        text: shown,
        createdAt: new Date().toISOString(),
        proposals: {},
        winner: null,
        outcome: 'Saved as a standing rule.',
      })
      setTurns(loadTurns(slug))
      standing.add(rule)
      setMessage(shown)
      setParsed(null)
      setRulesOpen(true)
      return
    }

    setMessage(shown)
    // Anything left from a previous attempt goes now. Nothing was signed, so
    // nothing should survive the restart.
    sequence.reset()
    setExecutingKey(null)
    setPlacedId(null)
    setAffordError(null)
    setNairaForm(null)
    setNairaConvert(null)
    setCashOutAfterSwap(false)
    setCashOutFrom(null)
    setPendingInput(null)
    const newTurnId = crypto.randomUUID()
    setTurnId(newTurnId)
    setHistoryOpen(false)
    setRestored(null)
    setPending(null)

    // Every instruction is kept as a chat the moment it starts. Most are then
    // rewritten by the race that follows; a payout, a send, a supply or a rule
    // has no race, and this is the only record that it was asked.
    saveTurn({
      id: newTurnId,
      chain: slug,
      text: shown,
      createdAt: new Date().toISOString(),
      proposals: {},
      winner: null,
      ...(options.conversation !== undefined && options.conversation.length > 1
        ? {
            conversation: options.conversation
              .slice(1)
              .filter((t) => !(t.role === 'assistant' && t.content === ACKNOWLEDGED)),
          }
        : {}),
    })
    setTurns(loadTurns(slug))

    // "Swap $5 of XLM to naira" is a payout to a bank, which no trade parser
    // below can express. Read first and by a closed list of currencies: a
    // currency that cannot be paid out is answered with what can, and naira
    // opens the form that collects the bank details.
    const payout = detectPayout(text)
    if (payout.kind !== 'none' && slug === 'stellar') {
      setParsed(null)
      setFollowOn(null)
      supply.reset()
      perp.reset()

      if (payout.kind === 'unsupported') {
        setAffordError(unsupportedCurrencyMessage(payout.currency))
        return
      }
      if (!isMainnet()) {
        setAffordError(
          'Naira payouts pay real money and run on Stellar mainnet only. Switch to mainnet to cash out.'
        )
        return
      }

      const source = readPayoutSource(text, swap.usdPrices?.['XLM'])
      // Any other asset is paid out by converting it to USDC first. Whether the
      // name is a real, verified asset is the server's answer, not the page's.
      const other =
        source.kind === 'other'
          ? { symbol: source.asset, amount: undefined }
          : namedPayoutAsset(text)
      const mentionsBase = /(xlm|usdc)/i.test(text)
      if (other !== undefined && (source.kind === 'other' || !mentionsBase)) {
        const wanted = other.symbol
        const wantedBy = latest.current.account
        void (async () => {
          let found: VerifiedAsset | undefined
          try {
            const res = await fetch(`/api/assets/resolve?symbols=${encodeURIComponent(wanted)}`)
            const body = (await res.json()) as { assets?: VerifiedAsset[] }
            found = body.assets?.find((a) => a.code === wanted)
          } catch {
            found = undefined
          }
          if (wantedBy !== latest.current.account) return
          if (found === undefined) {
            setAffordError(
              `I can't confirm ${wanted} as a verified token on Stellar, so I won't cash it out. Which token do you mean?`
            )
            return
          }
          registerLiveAsset(activeNetwork(), found)
          startSwapThenCashOut(wanted, other.amount)
        })()
        return
      }
      if (source.kind === 'other') return
      if (source.kind === 'usdc') {
        // USDC already held goes out as it is: no swap, so no route to choose.
        setNairaForm({
          key: Date.now(),
          path: 'xlm',
          asset: 'usdc',
          ...(source.amountUsdc !== undefined ? { amountXlm: source.amountUsdc } : {}),
        })
        return
      }
      // Linq takes USDC only, so a cash-out of XLM is a swap first.
      startSwapThenCashOut('XLM', source.amountXlm)
      return
    }

    // "Send 50 USDC to deon.xlm" is a payment, not a trade, and the trade
    // parser would read it as a buy of USDC. Read first, for the same reason
    // the supply reader is: every parser below assumes an intent is a trade.
    // The recipient goes to the server as typed; nothing here resolves it.
    const sendOnly = parseSendIntent(text, tradeableSymbols())
    if (sendOnly !== null && slug === 'stellar') {
      setParsed(null)
      setFollowOn(null)
      supply.reset()
      perp.reset()
      sequence.prepare({
        kind: 'send-only',
        asset: sendOnly.asset,
        amount: sendOnly.amount,
        ...(sendOnly.amountIsUsd ? { amountIsUsd: true } : {}),
        recipient: sendOnly.recipient,
        ...(sendOnly.memo !== undefined ? { memo: sendOnly.memo } : {}),
      })
      return
    }

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

      // The asset named, by its own contract. This always sent XLM's, so "supply 5 USDC" signed 5 XLM
      // under a card that said USDC. Refused when the pool does not lend the token held here.
      const reserve = suppliableReserve(supplyOnly.asset)
      if (reserve === undefined) {
        setAffordError(`Blend does not take ${supplyOnly.asset} here. Nothing was signed or sent.`)
        return
      }

      const units =
        supplyOnly.amount === undefined
          ? heldUnits(supplyOnly.asset)
          : supplyOnly.amountIsUsd === true
            ? (Number(supplyOnly.amount) / (price as number)).toFixed(7)
            : supplyOnly.amount

      supply.prepare({
        assetId: reserve,
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
    const given = options.reading
    const single =
      given !== undefined && given.action === 'swap'
        ? buildParsedIntent(
            {
              text,
              tokenIn: given.tokenIn,
              tokenOut: given.tokenOut,
              amount: given.amountUsd,
              amountIsUsd: given.amountIsUsd,
              ...(given.amountOf !== undefined ? { amountOf: given.amountOf } : {}),
              style: given.style,
              ...(given.limitPriceUsd !== undefined ? { limitPriceUsd: given.limitPriceUsd } : {}),
            },
            swap.usdPrices
          )
        : parseIntent(text, swap.usdPrices)
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
    const readFor = latest.current.account
    void (async () => {
      setParsing(true)
      let read: UnderstoodIntent | null = null
      try {
        // Already read when the orchestrator wrote this instruction. Asking the
        // parser again would be a second opinion on words it has just rewritten.
        const raw: unknown =
          options.reading !== undefined
            ? { understood: true, ...options.reading }
            : await (
                await fetch('/api/intent/parse', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text, chain: slug }),
                })
              ).json()
        if (readFor !== latest.current.account) return
        const body = raw as {
          understood?: boolean
          action?: 'swap' | 'supply' | 'borrow' | 'repay' | 'offramp'
          tokenIn?: string
          tokenOut?: string
          amountUsd?: number
          amountStated?: boolean
          amountIsUsd?: boolean
          followOn?: FollowOnAction | null
          liveAssets?: VerifiedAsset[]
          reason?: string
          tokens?: string[]
        }
        // Tokens the server proved this request, so the page can trade them
        // without a hand-written entry.
        for (const asset of body.liveAssets ?? []) {
          registerLiveAsset(activeNetwork(), asset)
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
          if (!(await offrampSession())) return
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

          const reserve = suppliableReserve(symbol)
          if (reserve === undefined) {
            setParsed(null)
            setFollowOn(null)
            setAffordError(`Blend does not take ${symbol} here. Nothing was signed or sent.`)
            return
          }

          const units = !stated
            ? heldUnits(symbol)
            : body.amountIsUsd === true
              ? ((body.amountUsd ?? 0) / (price as number)).toFixed(7)
              : String(body.amountUsd ?? 0)

          setParsed(null)
          setFollowOn(null)
          supply.prepare({ assetId: reserve, symbol, amount: toBaseUnits(units) })
          return
        }
        // A token the app cannot vouch for: ask rather than guess. Nothing is run.
        if (body.understood === false && body.reason === 'unknown_token' && slug === 'stellar') {
          const names = (body.tokens ?? []).join(', ')
          setParsed(null)
          setFollowOn(null)
          setAffordError(
            `I can't confirm ${names} as a verified token on Stellar, so I won't trade it. Which token do you mean? You can name it another way, or paste its issuer account if you know it.`
          )
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
        if (!(await offrampSession())) return
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
      // When the orchestrator read the instruction, its answer on the follow-on
      // stands: falling back to the regex would add one it decided was not asked.
      const readFollowOn =
        options.reading !== undefined ? (read?.followOn ?? null) : (read?.followOn ?? regexFollowOn)
      if (readFollowOn !== null) {
        setPending({
          text,
          tokenIn: read?.tokenIn ?? single.input.tokenIn,
          tokenOut: read?.tokenOut ?? single.input.tokenOut,
          amountUsd: read?.amountStated === true ? read.amountUsd : single.escrowUsd,
          amountStated: read?.amountStated ?? true,
          followOn: readFollowOn,
          ...(options.reading !== undefined ? { parsed: single } : {}),
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

  /** All of an asset the wallet holds, as a display figure. */
  function heldUnits(symbol: string): string {
    return (symbol === 'XLM' ? balances?.xlm : balances?.trustlines?.[symbol]?.balance) ?? '0'
  }

  /**
   * "Withdraw 25 XLM" and "repay 5 USDC" on Stellar. Straight to a card to sign, with no model
   * in the way: see `parse-exit.ts`. The server reads the position and says if it can't be done.
   */
  function startStellarExit(exit: StellarExit, text: string): void {
    if (executionInFlight) {
      setAffordError(FINISH_SIGNATURE_NOTICE)
      return
    }
    archiveOpenTurn()
    resetTurnState()
    setClarifying(null)
    setParsed(null)
    setMessage(text)
    setTurnId(crypto.randomUUID())

    if (exit.kind === 'where') {
      if (!isConnected || address === undefined) {
        setAffordError('Connect a wallet first, so there is an account to look at.')
        return
      }
      void fetch(`/api/lend/position?account=${encodeURIComponent(address)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error('unread')
          const body = (await res.json()) as { positions?: BlendPositions | null }
          if (body.positions == null) throw new Error('unread')
          setAffordError(whereReply(body.positions))
        })
        .catch(() => {
          setAffordError('Could not read your Blend position. Nothing was signed or sent.')
        })
      return
    }

    let amount: string | undefined
    try {
      amount = exit.amount === undefined ? undefined : toBaseUnits(exit.amount)
    } catch {
      setAffordError(
        'That amount has more decimal places than Stellar keeps. Nothing was signed or sent.'
      )
      return
    }
    const request = { symbol: exit.symbol, ...(amount !== undefined ? { amount } : {}) }
    if (exit.kind === 'withdraw') exitWithdraw.prepare(request)
    else exitRepay.prepare('repay', request)
  }

  /** Ends a chain sequence where it stands. Its USDC stays the person's, and they are told so. */
  function leaveSequence(): void {
    const run = chainSequenceNow.current
    const note = endedNote(run.stage, run.delivered, run.sequence)
    setSequenceNote(note ?? null)
    if (note !== undefined) {
      recordLive('agent', note, undefined, run.account ?? chatOwner.current)
    }
    run.clear()
  }

  /** Step 2's press. A model's answer still on its way must not start anything under it. */
  function pressNextStep(): void {
    latest.current.turn += 1
    chainSequence.runNext()
  }

  // Step 2 follows the swap by itself, until the person does something else. Leaving this chat or
  // typing anything hands it to them for the rest of the run: a wallet must not open over another
  // page, over a card that went stale meanwhile, or against "wait, don't deposit". The button stays.
  useEffect(() => {
    if (!showing) {
      autoStoppedFor.current = chainSequence.sequence
      return
    }
    if (clarifyBusy || autoStoppedFor.current === chainSequence.sequence) return
    const move = chainSequence.takeAutoMove()
    if (move === 'prepare') pressNextStep()
    else if (move === 'sign') chainAction.confirm()
    // Both change identity with their state; these are what can make a move due.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing, clarifyBusy, chainSequence.stage, chainAction.phase, chainAction.prepared])

  /** Step 1: the same race as a plain swap, with the sequence watching its card. */
  function runSequenceSwap(request: ChainSequenceRequest, text: string): void {
    // Sized here and not on the way in, so a currency question left open is priced when answered.
    if (request.swap.amountIsUsd === true) {
      sizeThen(request.swap, text, (swap) => runSequenceSwap({ ...request, swap }, text))
      return
    }
    setAffordError(null)
    // A new race is the one thing that lifts the "already signed" latch.
    chainAction.release()
    chainAction.reset()
    chainSequence.start(request, text)
    setChainRace({ request: request.swap, text })
  }

  /**
   * "$5 of SOL" as a count of SOL at a price read now, and says so. The two places a race or a card
   * starts come through here first, so a figure in dollars can't reach one as that many tokens.
   */
  function sizeThen(
    request: ChainActionRequest,
    text: string,
    go: (sized: ChainActionRequest) => void
  ): void {
    setMessage(text)
    setClarifying(null)
    setAffordError(null)
    clearChainRace()
    chainAction.reset()
    setClarifyBusy(true)
    const { turn, account, chain } = latest.current
    void sizeInUnits(slug, request).then((out) => {
      if (clarifyRuns.current === 0) setClarifyBusy(false)
      // The person has moved on, and nothing must start under what they did next.
      const now = latest.current
      if (turn !== now.turn || account !== now.account || chain !== now.chain) return
      if ('refusal' in out) {
        chainAction.refuse(out.refusal, text)
        return
      }
      go(out.request)
      const { line } = out
      if (line !== undefined) {
        // Added to, not over, a note on what a run left behind, such as USDC still in the wallet.
        setSequenceNote((shown) => (shown === null ? line : `${shown} ${line}`))
        recordLive('agent', line)
      }
    })
  }

  /** A plain chain action, typed or read by the orchestrator: the race, or the card for a send. */
  function startChainAction(action: ChainActionRequest, text: string): void {
    if (action.amountIsUsd === true) {
      sizeThen(action, text, (sized) => startChainAction(sized, text))
      return
    }
    // The thread only renders once there is a message, so without this the
    // card below would be built and never seen.
    setMessage(text)
    // A reopened turn, an open Stellar intent and its saved id all end here,
    // so the race is the only thing on screen and is not saved over them.
    resetTurnState()
    setParsed(null)
    setTurnId(null)
    setClarifying(null)
    setAffordError(null)
    // The agents race first; Review on a route is what builds it. A new
    // race is the one thing that lifts the "already signed" latch.
    chainAction.release()
    chainAction.reset()
    if (racesFirst(action)) {
      setChainRace({ request: action, text })
    } else {
      // Nothing to price or choose, so a stale race is cleared and the card comes straight up.
      clearChainRace()
      chainAction.prepare(action, text)
    }
  }

  /** A swap and what follows it. Whatever could not finish is refused here, before step 1. */
  function startChainSequence(request: ChainSequenceRequest, text: string): void {
    const capabilities = chainCapabilities(slug)
    if (capabilities === undefined) return
    const { followOn } = request
    setMessage(text)
    resetTurnState()
    setParsed(null)
    setTurnId(null)
    setClarifying(null)
    const refusal =
      (followOn.kind === 'cashout' && cashout.locked ? CASHOUT_UNDER_WAY : undefined) ??
      followOnRefusal(
        slug as ChainWithActions,
        descriptor.name,
        followOn,
        capabilities.map((c) => ({ kinds: [c.kind] })),
        request.swap.tokenOut
      )
    if (refusal !== undefined) {
      chainAction.refuse(refusal, text)
      return
    }
    if (followOn.kind !== 'cashout') {
      if (address === undefined) {
        chainAction.refuse('Connect a wallet first.', text)
        return
      }
      // Asked of the server before step 1, since a step that can't run is no use after it.
      chainAction.reset()
      setClarifyBusy(true)
      const { turn, account, chain } = latest.current
      void readFollowOnPlan(slug, request, address).then((plan) => {
        if (clarifyRuns.current === 0) setClarifyBusy(false)
        // The person has moved on, and a swap must not start under what they did next.
        const now = latest.current
        if (turn !== now.turn || account !== now.account || chain !== now.chain) return
        if ('refusal' in plan) {
          chainAction.refuse(plan.refusal, text)
          return
        }
        if (plan.note !== undefined) recordLive('agent', plan.note)
        runSequenceSwap(
          plan.note === undefined ? plan.request : { ...plan.request, note: plan.note },
          text
        )
      })
      return
    }
    // Asked of Weave before step 1, since a currency it can't pay is no use after it.
    cashout.dismiss()
    chainAction.reset()
    setClarifyBusy(true)
    const { turn, account, chain } = latest.current
    void fetchCashoutCurrencies(slug).then((weave) => {
      if (clarifyRuns.current === 0) setClarifyBusy(false)
      // The person has moved on, and a swap must not start under what they did next.
      const now = latest.current
      if (turn !== now.turn || account !== now.account || chain !== now.chain) return
      const step = currencyStep(followOn.currency, cashoutChoices(slug, weave))
      if (step.kind === 'refuse') {
        chainAction.refuse(step.message, text)
      } else if (step.kind === 'ask') {
        setCashoutQuestion({ choices: step.choices, sequence: { request, chain } })
        recordLive('agent', CURRENCY_QUESTION)
      } else {
        runSequenceSwap(
          { ...request, followOn: { kind: 'cashout', currency: step.currency } },
          text
        )
      }
    })
  }

  /** A cash-out read from the composer: the card, or a plain answer about what it can't do. */
  function startCashout(route: Exclude<CashoutRoute, { kind: 'pass' }>, text: string): void {
    if (executionInFlight) {
      setAffordError(FINISH_SIGNATURE_NOTICE)
      return
    }
    setMessage(text)
    // A chain race in progress ends here; resetting the card also drops any
    // build still in flight, so it cannot land over the cash-out.
    if (chainRace !== null) {
      clearChainRace()
      chainAction.reset()
      setExecutingKey(null)
    }
    setRestored(null)
    setHistoryOpen(false)
    setTurnId(null)
    setParsed(null)
    setFollowOn(null)
    setPending(null)
    setClarifying(null)
    setCashoutQuestion(null)
    setAffordError(null)
    setNairaForm(null)
    sequence.reset()
    supply.reset()
    perp.reset()

    if (route.kind === 'sequence') {
      startChainSequence(cashoutSequence(route), text)
      return
    }

    if (route.kind === 'ask') {
      if (cashout.locked) {
        chainAction.refuse(
          'A cash-out is already under way. Follow it here, and do not send it again.',
          text
        )
        return
      }
      cashout.dismiss()
      chainAction.reset()
      setClarifyBusy(true)
      const asked = latest.current.turn
      const askedFor = latest.current.account
      void fetchCashoutCurrencies(slug).then((weave) => {
        setClarifyBusy(false)
        if (askedFor !== latest.current.account) return
        const choices = cashoutChoices(slug, weave)
        const only = choices.length === 1 ? choices[0] : undefined
        if (choices.length === 0) {
          chainAction.refuse(NO_CASHOUTS, text)
        } else if (only !== undefined) {
          // Nothing to ask about when one currency is all there is.
          payOutIn(only.code, route.amount, text)
        } else {
          setCashoutQuestion({
            choices,
            ...(route.amount !== undefined ? { amount: route.amount } : {}),
          })
          if (asked === latest.current.turn) recordLive('agent', CURRENCY_QUESTION)
        }
      })
      return
    }

    if (route.kind === 'open') {
      if (cashout.locked) {
        chainAction.refuse(
          'A cash-out is already under way. Follow it here, and do not send it again.',
          text
        )
      } else if (slug === 'stellar' && !isMainnet()) {
        chainAction.refuse(
          'Cash-outs pay real money and run on Stellar mainnet only. Switch to mainnet to cash out.',
          text
        )
      } else {
        chainAction.reset()
        cashout.open({
          ...(route.amount !== undefined ? { amount: route.amount } : {}),
          ...(route.currency !== undefined ? { currency: route.currency } : {}),
        })
      }
      return
    }

    cashout.dismiss()
    if (route.kind === 'token') {
      chainAction.refuse(unsupportedTokenReply(route.token, slug), text)
      return
    }
    const refusedFor = latest.current.account
    void fetchCashoutCurrencies(slug).then((currencies) => {
      if (refusedFor !== latest.current.account) return
      chainAction.refuse(unsupportedCurrencyReply(route.currency, currencies), text)
    })
  }

  /** The currency is settled: the form that pays it. Naira on Stellar stays on the Linq form. */
  function payOutIn(currency: string, amount: string | undefined, text: string): void {
    chainAction.reset()
    if (slug === 'stellar' && currency === 'NGN') {
      const id = crypto.randomUUID()
      setTurnId(id)
      saveTurn({
        id,
        chain: slug,
        text,
        createdAt: new Date().toISOString(),
        proposals: {},
        winner: null,
      })
      setTurns(loadTurns(slug))
      setNairaForm({
        key: Date.now(),
        path: 'xlm',
        asset: 'usdc',
        ...(amount !== undefined ? { amountXlm: Number(amount) } : {}),
      })
      return
    }
    cashout.open({
      ...(amount !== undefined ? { amount } : {}),
      currency: currency as CashoutCurrencyCode,
    })
  }

  /** A currency named in answer to the question: used if offered, and said back if not. */
  function answerNamedCurrency(named: string, text: string): void {
    if (cashoutQuestion === null) return
    const offered = cashoutQuestion.choices
    if (offered.some((choice) => choice.code === named)) {
      answerCashoutQuestion(named, text)
    } else {
      const reply = unsupportedCurrencyReply(named, offered)
      setCashoutQuestion({ ...cashoutQuestion, retry: { said: text, reply } })
      recordLive('agent', reply)
    }
  }

  function answerCashoutQuestion(currency: string, said: string): void {
    const asked = cashoutQuestion
    if (asked === null) return
    setCashoutQuestion({ ...asked, answer: said })
    if (asked.sequence !== undefined) {
      const elsewhere = questionChainRefusal(asked.sequence.chain, slug)
      if (elsewhere !== undefined) {
        chainAction.refuse(elsewhere, message ?? said)
        return
      }
      runSequenceSwap(
        {
          ...asked.sequence.request,
          followOn: { kind: 'cashout', currency: currency as CashoutCurrencyCode },
        },
        message ?? said
      )
      return
    }
    payOutIn(currency, asked.amount, message ?? said)
  }

  /**
   * One request or answer from the composer.
   *
   * A complete instruction goes straight to the agents. Anything missing
   * something material goes to the clarifier first, which asks one question at
   * a time and, once nothing is missing, hands back the request written out on
   * its own. The clarifier failing or running out of questions means the user's
   * own words run, so asking never makes the chat less capable than before.
   */
  function handleSubmit(typed: string): void {
    latest.current.turn += 1
    autoStoppedFor.current = chainSequenceNow.current.sequence
    // A misspelled verb is corrected before anything reads the sentence. "Tell me my positions"
    // has none, and would become "sell me".
    const text = asksForPositions(typed) ? typed : fixVerbTypo(typed)

    // A chain signature is with the wallet: a new message must not close its card.
    if (chainSigning(chainAction.phase)) {
      setAffordError(FINISH_SIGNATURE_NOTICE)
      return
    }

    setOrdersShown(null)
    const cashoutRoute = routeCashout(parseCashout(text), slug, isMainnet())
    const capabilities = chainCapabilities(slug)
    const chainRead =
      capabilities === undefined
        ? null
        : readChainMessage(text, slug as ChainWithActions, descriptor.name)
    const open = message !== null && parsed !== null && restored === null && !turnExecuted

    // Kept as it is shown. Two paths turn it away under a signature and never show it.
    const refused =
      executionInFlight &&
      (cashoutRoute.kind !== 'pass' ||
        (clarifying === null && open && classifyFollowUp(text) === 'note'))
    if (!refused) {
      recordLive('user', text)
      if (keepsRun(chainSequence.stage, messageStartsAction(cashoutRoute, chainRead))) {
        setSequenceNote(null)
      } else {
        leaveSequence()
      }
    }

    // "cash out to KES" at the question of a swap waiting on it answers that question,
    // where read as a request it would drop the swap.
    const routedAnswer = questionAnswerFrom(cashoutQuestion, cashoutRoute)
    if (routedAnswer !== undefined) {
      answerNamedCurrency(routedAnswer, text)
      return
    }

    if (cashoutRoute.kind !== 'pass') {
      startCashout(cashoutRoute, text)
      return
    }

    const stellarExit = slug === 'stellar' ? parseStellarExit(text) : null
    if (stellarExit !== null) {
      startStellarExit(stellarExit, text)
      return
    }

    // The answer to "which currency?". Anything that isn't one closes the question
    // and is read as what it is, so nobody is held in it.
    if (cashoutQuestion !== null && cashoutQuestion.answer === undefined) {
      const answer = parseCurrencyAnswer(text)
      if (answer !== null) {
        answerNamedCurrency('currency' in answer ? answer.currency : answer.unsupported, text)
        return
      }
    }
    setCashoutQuestion(null)

    cashout.dismiss()
    if (chainCapabilities(slug) === undefined) chainAction.reset()

    // Chains with their own module have their own path: the race and the swap routes
    // below are Stellar's. What the strict parsers can't read in full goes to the
    // orchestrator, verbs or not, and `readChainMessage` is what decides that.
    if (chainRead !== null) {
      if (chainRead.kind === 'refusal') {
        setClarifying(null)
        setMessage(text)
        clearChainRace()
        chainAction.refuse(chainRead.refusal, text)
        return
      }
      if (chainRead.kind === 'sequence') {
        startChainSequence(chainRead.request, text)
        return
      }
      if (chainRead.kind === 'cashout') {
        startCashout(chainRead.route, text)
        return
      }
      if (chainRead.kind === 'action' || chainRead.kind === 'limit') {
        startChainAction(chainRead.action, text)
        return
      }
      if (chainRead.kind === 'orders') {
        setClarifying(null)
        setMessage(text)
        resetTurnState()
        setParsed(null)
        setTurnId(null)
        clearChainRace()
        chainAction.reset()
        setOrdersShown(text)
        return
      }
      // A step 2 card still unsigned goes too, and the run's button is what brings it back.
      chainAction.reset()
      clearChainRace()
    }

    // An answer to a question already asked.
    if (clarifying !== null) {
      void clarify(text, clarifying.turns)
      return
    }

    // A note on an open intent refines it and needs no question of its own.
    if (open && classifyFollowUp(text) === 'note') {
      void refine(text)
      return
    }

    // Every message goes to the orchestrator first. Nothing decides by wording
    // whether it is worth asking: "flip my lumens into dollars" has no verb a
    // list would know, and "I want to go jogging" has none either.
    void clarify(text, [])
  }

  /**
   * A note on the open intent, written back into the instruction when it can be.
   *
   * "Make it $5" given to the agents as context does not change what they are
   * quoting: the amount, the pair and the routes were fixed by the sentence
   * that opened the turn. So the model rewrites the open request with the
   * change applied, and that is what races again. If it cannot, the note still
   * goes to every agent as context, which is all it did before.
   */
  async function refine(note: string): Promise<void> {
    if (executionInFlight) {
      setAffordError(FINISH_SIGNATURE_NOTICE)
      return
    }
    await clarify(
      note,
      [
        { role: 'user', content: message ?? '' },
        { role: 'assistant', content: ACKNOWLEDGED },
      ],
      { note }
    )
  }

  /** What the wallet holds. Stellar lists every asset from balances already read; other chains are read from the chain now. */
  async function walletBalanceReply(): Promise<string> {
    if (slug === 'stellar') return balanceMessage(isConnected ? balances : undefined)
    if (!isConnected || address === undefined) return balanceMessage(undefined)
    let held: WalletBalances | undefined
    try {
      const response = await fetch(
        `/api/chain/${slug}/balances?account=${encodeURIComponent(address)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(20_000) }
      )
      if (response.ok) {
        const body = (await response.json()) as Partial<WalletBalances>
        if (Array.isArray(body.tokens)) held = body as WalletBalances
      }
    } catch {
      held = undefined
    }
    return chainBalanceReply(held, descriptor.name)
  }

  async function clarify(
    text: string,
    prior: ClarifyTurn[],
    options: { note?: string } = {}
  ): Promise<void> {
    const turns: ClarifyTurn[] = [...prior, { role: 'user', content: text }]

    if (prior.length === 0) {
      // A new turn: the one before it is put away and the screen cleared, so the
      // question is asked on an empty page rather than under the last answer.
      archiveOpenTurn()
      resetTurnState()
      setParsed(null)
      setMessage(text)
      setTurnId(crypto.randomUUID())
    }
    latest.current.turn += 1
    const asked = { ...latest.current }
    clarifyRuns.current += 1
    setClarifying({ turns })
    setClarifyBusy(true)

    setAffordError(null)
    const earlier = raceContext(thread, [])
    // The conversation so far, replies included. Without it every message is
    // read cold, and "explain that better" has nothing to improve on.
    // A question about positions needs no model, and takes the balance path from here on.
    const positions = asksForPositions(text)
    const answer = positions
      ? { outcome: 'balance' as const }
      : await fetchOrchestrate(turns, earlier, slug, fetch, dialogue.current)
    // The busy indicator stays up until the holdings are read. A reply that arrives after the
    // person moved to another wallet, chain or message is not theirs any more, so it is dropped.
    const balanceText = positions
      ? await readPositionsReply(slug, descriptor.name, isConnected ? address : undefined)
      : answer.outcome === 'balance'
        ? await walletBalanceReply()
        : undefined
    clarifyRuns.current -= 1
    if (clarifyRuns.current === 0) setClarifyBusy(false)
    // The last wallet's question, answered after it left. A balance has its own rule below.
    if (balanceText === undefined && asked.account !== latest.current.account) return
    const decision =
      balanceText === undefined
        ? { kind: 'show' as const }
        : balanceReplyDecision(asked, latest.current)
    if (decision.kind === 'drop') return
    if (decision.kind === 'notice') {
      setClarifying(null)
      setAffordError(decision.text)
      return
    }

    if (answer.outcome === 'ask') {
      setClarifying({ turns: [...turns, { role: 'assistant', content: answer.question }] })
      if (asked.turn === latest.current.turn) recordLive('agent', answer.question)
      return
    }

    setClarifying(null)

    const chainCaps = chainCapabilities(slug)
    const said = turns.filter((turn) => turn.role === 'user').map((turn) => turn.content)

    // No model read this. Why, or what works here if it asks for something, is said in its place.
    if (
      answer.outcome === 'unavailable' &&
      chainCaps !== undefined &&
      asked.turn === latest.current.turn
    ) {
      const help = helpForUnread(answer.reason, said, descriptor.name, chainCaps)
      if (help !== undefined) {
        setParsed(null)
        setFollowOn(null)
        clearChainRace()
        chainAction.refuse(help, turns[0]?.content ?? text)
        return
      }
    }

    // Nothing runs: the message is not an instruction, or could not be read.
    // The reply is the model's own, written for this message in this
    // conversation. Fixed text is only what is shown when there was no model to
    // write one — an outage, or a reply that came back empty.
    if (answer.outcome !== 'act') {
      setParsed(null)
      setFollowOn(null)
      const reply =
        answer.outcome === 'help'
          ? (answer.reply ?? helpMessage(slug))
          : answer.outcome === 'balance'
            ? (balanceText as string)
            : answer.outcome === 'out_of_scope'
              ? outOfScopeMessage(slug, answer.reply)
              : answer.outcome === 'unclear'
                ? (answer.reply ?? unclearMessage())
                : unavailableMessage(answer.reason, answer.tokens)
      setAffordError(reply)
      // Remembered only when the model wrote it: a stock error line is not
      // something it said, and feeding it back would teach it to repeat.
      if (answer.outcome === 'out_of_scope') {
        // The boundary, not the list that follows it: the list is fixed copy and
        // would only crowd the conversation the model is shown.
        dialogue.current = rememberExchange(
          dialogue.current,
          text,
          [answer.reply, "That's outside what Intent does."].filter(Boolean).join(' ')
        )
      } else if (
        answer.outcome !== 'unavailable' &&
        'reply' in answer &&
        answer.reply !== undefined
      ) {
        dialogue.current = rememberExchange(dialogue.current, text, reply)
      }
      return
    }

    // An instruction starts a trade; what was said before it is no longer the
    // conversation the next message belongs to.
    dialogue.current = []

    // Off Stellar nothing may start under whatever was said or pressed while this was being read.
    if (
      chainCaps !== undefined &&
      (asked.turn !== latest.current.turn || asked.chain !== latest.current.chain)
    ) {
      return
    }

    // The model wrote out a cash-out, perhaps from words no parser here would read.
    const writtenOut = routeCashout(parseCashout(answer.instruction), slug, isMainnet())
    if (writtenOut.kind !== 'pass') {
      const shown = turns[0]?.content ?? text
      // What gets signed comes from the person's own words, never from the model's.
      if (writtenOut.kind === 'sequence' && !cashoutSaid(writtenOut, said)) {
        startCashout({ kind: 'token', token: writtenOut.token }, shown)
        return
      }
      if (chainCaps !== undefined && cashoutStarts(writtenOut)) leaveSequence()
      startCashout(writtenOut, shown)
      return
    }

    // Off Stellar a reading never reaches Stellar's swap and lend flows below. It goes where a typed
    // sentence goes, and only what the person typed themselves can be signed.
    if (chainCaps !== undefined) {
      const shown = turns[0]?.content ?? text
      const route = chainRouteFromReading(
        answer.read,
        answer.instruction,
        said,
        slug as ChainWithActions
      )
      if (route !== null && 'sequence' in route) {
        leaveSequence()
        startChainSequence(route.sequence, shown)
      } else if (route !== null && 'action' in route) {
        leaveSequence()
        startChainAction(route.action, shown)
      } else {
        setMessage(shown)
        clearChainRace()
        chainAction.refuse(
          route !== null ? route.refusal : chainHelp(descriptor.name, chainCaps),
          shown
        )
      }
      return
    }

    // Tokens the server proved for this request, so the page can trade them
    // without a hand-written entry.
    for (const asset of answer.read.liveAssets) {
      registerLiveAsset(activeNetwork(), asset)
    }

    if (options.note !== undefined) {
      setNotes((n) => [...n, options.note as string])
      setExecutingKey(null)
    }
    startIntent(answer.instruction, {
      shown: turns[0]?.content ?? text,
      brief: answer.context,
      continuing: true,
      conversation: turns,
      reading: answer.read,
    })
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
    setParsed(confirmed.parsed ?? parseIntent(confirmed.text, swap.usdPrices))
  }

  /** A clean slate: the open intent, the turns before it and any notes. */
  function newChat(): void {
    // While a switch waits on a signature the chat on screen is neither wallet's to clear.
    if (transcriptOwner !== undefined && transcriptOwner === chatOwner.current) {
      clearLiveSession(liveSessionStorage(), segment, transcriptOwner)
    }
    clearOpenChat()
    setSavedTurns(null)
  }

  function clearOpenChat(): void {
    latest.current.turn += 1
    handleReset()
    setThread([])
    setNotes([])
    setInSaved({ thread: 0, notes: 0 })
    setClarifying(null)
    setClarifyBusy(false)
    setCashoutQuestion(null)
    setBrief([])
    setStrategy({})
  }

  function handleReset(): void {
    // The card holds a signature in flight; closing it would orphan the transaction.
    if (chainSigning(chainAction.phase)) return
    latest.current.turn += 1
    chainSequence.clear()
    setSequenceNote(null)
    if (slug !== 'stellar') chainAction.reset()
    // The thread stays while a cash-out is under way: it carries the warning not to resend.
    setMessage(cashout.locked ? message : null)
    cashout.dismiss()
    setCashoutQuestion(null)
    setParsed(null)
    clearChainRace()
    setExecutingKey(null)
    setPlacedId(null)
    setAffordError(null)
    setNairaForm(null)
    setNairaConvert(null)
    setCashOutAfterSwap(false)
    setCashOutFrom(null)
    setPendingInput(null)
    setRestored(null)
    setTurnId(null)
    // Cleared with everything else. Leaving it behind kept a card from the
    // previous attempt on screen, mid-sequence, with nothing signed — which
    // read as a stuck transaction that had never existed.
    setFollowOn(null)
    sequence.reset()
    // The turns so far stay on screen as a reload would show them. The thread and
    // notes behind them still go to the agents, so they are hidden, not dropped.
    const owner = chatOwner.current
    if (owner === undefined) return
    const turns = loadLiveSession(liveSessionStorage(), segment, owner)
    setSavedTurns({ account: owner, turns })
    setInSaved(
      turns.length > 0 ? { thread: thread.length, notes: notes.length } : { thread: 0, notes: 0 }
    )
  }

  /**
   * A withdrawal needs a session before anything is signed.
   *
   * Its anchor transaction id lives only in the saved record, and that is the
   * one thing that cannot be recovered from the ledger. Connecting normally
   * signs in, but that is allowed to fail so swaps stay usable; a withdrawal is
   * the case where proceeding unrecorded costs the user their payout status.
   */
  async function offrampSession(): Promise<boolean> {
    if (address === undefined) return false
    try {
      await ensureSession(address)
      return true
    } catch {
      setAffordError(
        'Sign in with your wallet to withdraw. The payout is tracked against your account, and without a session it could not be followed afterwards.'
      )
      return false
    }
  }

  function handleExecute(key: string): void {
    if (!canReview(competition.proposals[key], routesByAgent[key], restored !== null)) return
    // Selecting an agent is not a commitment, so it must stay changeable.
    // Guarding on `executingKey` — set by the first Review click — meant the
    // first pick was final: every other card became unclickable before the
    // user had confirmed anything.
    //
    // A signature in flight is the real reason to refuse: past that point a
    // transaction is with the wallet or the network, and switching routes
    // would leave the wrong one submitted.
    // A race on another chain signs through that chain's own card, never the
    // Stellar swap hook.
    if (slug !== 'stellar' && chainRace !== null) {
      const outcome = reviewChainRoute({
        // Only this agent's own route: falling back to the winner's would sign
        // a trade the user did not pick.
        route: routesByAgent[key],
        asked: chainRace.request,
        text: chainRace.text,
        phase: chainAction.phase,
        signed: raceClosed(chainAction.signed === true, chainSequence.settled),
        preparedVenueId: chainAction.prepared?.venueId,
        ...(live.competitionId !== undefined ? { raceId: live.competitionId } : {}),
        prepare: chainAction.prepare,
        refuse: chainAction.refuse,
      })
      if (outcome === 'prepared') {
        setDirectFallback(false)
        setExecutingKey(key)
      }
      return
    }
    // A chain route with no race open (a reopened turn) is not for the Stellar path.
    if (isChainRoute(routesByAgent[key] ?? winnerRoute)) return

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
    // How to execute is the user's call when they made one, and the agent's
    // proposal otherwise. A price the user typed in the sentence still wins
    // over both: that is the one part of an intent a model does not move.
    const mode = strategy.mode ?? chosenPlan?.executionMode
    const restingPrice =
      mode === 'rest'
        ? (parsed.limitPriceUsd ?? strategy.restPriceUsd ?? chosenPlan?.restPriceUsd)
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

    // A naira payout that converts first: the swap into USDC the user chose,
    // then a payout of whatever it delivers. The bank details were collected
    // before the race, so the order can be made the moment the swap settles.
    if (slug === 'stellar' && nairaConvert !== null) {
      const route = routesByAgent[key] ?? winnerRoute
      if (route === undefined || parsed.input.tokenOut !== 'USDC') {
        setAffordError('No executable route into USDC was found, so the payout cannot start.')
        return
      }
      sequence.prepare({
        kind: 'swap-then-naira',
        ...slippageEdit,
        quote: route,
        receiveSymbol: 'USDC',
        bankCode: nairaConvert.bankCode,
        accountNumber: nairaConvert.accountNumber,
        swapLabel: `Swap ${parsed.input.amountIn} ${parsed.input.tokenIn} for USDC`,
      })
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

        // The token the swap delivers, by its own contract. This always named XLM's, so a swap into
        // USDC went on to supply that many XLM. Said before the swap, not after it has run.
        const lendAsset = suppliableReserve(parsed.input.tokenOut)
        if (venue === 'blend' && lendAsset === undefined) {
          setAffordError(
            `Blend does not take ${parsed.input.tokenOut} here, so this cannot end in a supply. Nothing was signed or sent.`
          )
          return
        }

        sequence.prepare({
          kind: 'swap-then-lend',
          ...slippageEdit,
          quote: route,
          receiveSymbol: parsed.input.tokenOut,
          lendAsset: lendAsset ?? '',
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
          if (!(await offrampSession())) return
          // The anchor's limits, so the size is checked before signature one.
          let limits: WithdrawLimits | undefined
          try {
            const res = await fetch(`/api/offramp/anchor?id=${anchor}`)
            const info = (await res.json()) as { limits?: WithdrawLimits | null; error?: string }
            const answer = classifyAnchorAnswer(res.status, info)
            if (answer.kind === 'refused') {
              // The server says this anchor cannot be used here — on mainnet
              // with no off-ramp configured, that is the whole answer. The
              // swap is not prepared: its second half cannot happen, and the
              // user is told why instead of being sold the first half.
              setAffordError(answer.message)
              return
            }
            if (answer.kind === 'unreachable') {
              // An unreachable anchor was read as "no limits", so the size
              // warning silently disappeared and the user heard nothing at
              // all. Said out loud, and the sequence still prepared without
              // limits: the build route refuses an out-of-range withdrawal
              // later, so losing the early warning is the honest degradation
              // rather than a reason to refuse a trade the user asked for.
              setAffordError(answer.message)
            } else if (answer.limits !== undefined) {
              limits = answer.limits
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
            ...slippageEdit,
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

    // The same shape again, ending at somebody's account. The recipient is
    // resolved on the server when the payment is built, after the swap has
    // settled and its delivery is known; nothing here names an address.
    if (
      slug === 'stellar' &&
      followOn !== null &&
      followOn.kind === 'send' &&
      followOn.recipient !== undefined
    ) {
      const route = routesByAgent[key] ?? winnerRoute
      if (route !== undefined) {
        sequence.prepare({
          kind: 'swap-then-send',
          ...slippageEdit,
          quote: route,
          receiveSymbol: parsed.input.tokenOut,
          recipient: followOn.recipient,
          swapLabel: `Swap ${parsed.input.amountIn} ${parsed.input.tokenIn} for ${parsed.input.tokenOut}`,
        })
        return
      }
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
      <div className="border-border bg-card/80 relative flex shrink-0 items-center gap-1 border-b px-4 py-2.5 backdrop-blur">
        <ChatIdentity />
        {/* The rate every dollar amount on this page is sized against.
            "$20 worth of XLM" becomes a token count using this number, so
            showing it lets the user see the conversion before writing the
            sentence rather than after signing it. Hidden on narrow screens,
            where the centred label and the actions already compete. */}
        <div
          data-testid="chain-price"
          className="border-border ml-4 hidden border-l pl-4 empty:hidden md:block"
        >
          {slug === 'stellar' ? <PriceTicker prices={swap.priceDetail} /> : <NativeCoinTicker />}
        </div>
        {/* Past conversations. The chat keeps nothing across a reload on its
            own, so without this the agents' reasoning is lost the moment the
            page refreshes or a second intent is composed. */}
        {/* A new chat, kept apart from the intent in front of the user: it also
            drops the earlier turns, so it is the one way to start from nothing. */}
        <button
          type="button"
          onClick={newChat}
          aria-label="New chat"
          title="New chat"
          className="text-muted-foreground hover:text-foreground hover:bg-muted/60 ml-auto rounded-full p-1.5 transition-colors"
        >
          <Plus className="h-4 w-4" />
        </button>

        {isConnected ? (
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-label="Past intents"
            aria-expanded={historyOpen}
            className={cn(
              'rounded-full p-1.5 transition-colors',
              historyOpen
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
            )}
          >
            <Clock className="h-4 w-4" />
          </button>
        ) : null}
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
            turns={listedTurns}
            onSelect={(turn) => {
              if (chainSigning(chainAction.phase)) return
              leaveSequence()
              // Off Stellar, a price or check still on its way must not start anything over this.
              if (chainCapabilities(slug) !== undefined) latest.current.turn += 1
              // A race on screen ends when another turn is opened.
              if (chainRace !== null) {
                clearChainRace()
                chainAction.reset()
              }
              // Reopen exactly what was recorded. This used to resubmit the
              // text, which started a fresh competition and produced different
              // answers — the conversation was not being restored at all.
              setHistoryOpen(false)
              setRestored(turn)
              setMessage(turn.text)
              // A cash-out is reopened as the conversation it was, not re-read as a trade.
              setParsed(turn.outcome !== undefined ? null : parseIntent(turn.text, swap.usdPrices))
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
        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-5">
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
            <div
              className={
                transcript.length > 0
                  ? 'flex flex-col gap-4'
                  : 'flex h-full flex-col items-center justify-center gap-4 text-center'
              }
            >
              <SavedTurns turns={transcript} />
              {/* A swap from an earlier session settled meaning to be cashed
                  out, and the tab closed before that second step started.
                  The swap itself is already safe in history; this is only
                  the reminder that one more step was owed. */}
              {strandedCashOut !== undefined ? (
                <div className={cn(agentBubble, 'max-w-sm border-dashed text-left')}>
                  <p>
                    A swap settled with {strandedCashOut.receiveDisplay} USDC waiting to be cashed
                    out to naira.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => resumeStrandedCashOut(strandedCashOut)}
                      className="bg-bubble-me text-bubble-me-foreground hover:bg-brand hover:text-brand-foreground rounded-full px-4 py-1.5 text-xs font-medium transition-colors"
                    >
                      Cash it out now
                    </button>
                    <a
                      href={`${stellarNetwork.blockExplorerUrl}/tx/${strandedCashOut.swapHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                    >
                      View the swap
                    </a>
                  </div>
                </div>
              ) : null}

              {transcript.length === 0 ? (
                <>
                  <span className="bg-brand flex h-14 w-14 items-center justify-center rounded-full">
                    <Image
                      src="/images/intent-logo.png"
                      alt=""
                      width={512}
                      height={361}
                      className="h-6 w-auto invert"
                    />
                  </span>
                  <p className="text-muted-foreground max-w-sm text-sm">
                    Say what you want to happen. Autonomous agents compete to find the best
                    execution — you pick who executes.
                  </p>
                </>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <SavedTurns turns={transcript} />
              {/* A reopened conversation shows the prices that were quoted when
                it ran. Saying so matters: signing against a rate from an hour
                ago is a different decision from signing a fresh one. */}
              {restored !== null ? (
                <div className={systemPill}>
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

              {/* The turns before this one, quieter than the open intent. */}
              {thread.slice(inSaved.thread).map((turn) => (
                <div key={turn.id} className="flex flex-col gap-3">
                  <div className="flex flex-col items-end gap-1">
                    <div className={userBubble}>{turn.text}</div>
                    {turn.executed || turn.attempted === true ? (
                      <span className="text-muted-foreground mr-2 flex items-center gap-1 text-[11px]">
                        {turn.executed ? <CheckCheck className="text-brand h-3 w-3" /> : null}
                        {turn.executed ? 'Done' : 'Not executed'}
                      </span>
                    ) : null}
                  </div>
                  {turn.reply !== undefined ? (
                    <div className="flex flex-col gap-1">
                      {turn.reply.agentName !== undefined ? (
                        <span className="text-foreground ml-[50px] text-xs font-semibold">
                          {turn.reply.agentName}
                        </span>
                      ) : null}
                      <div className="flex items-end gap-2.5">
                        {turn.reply.agentKey !== undefined ? (
                          <AgentAvatar
                            seed={turn.reply.agentKey}
                            name={turn.reply.agentName ?? ''}
                            className="h-10 w-10"
                          />
                        ) : null}
                        <div className={cn(agentBubble, 'whitespace-pre-line')}>
                          {turn.reply.text}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}

              <motion.div
                key={message}
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="flex justify-end"
              >
                <div className={userBubble}>{message}</div>
              </motion.div>
              {restored?.conversation?.map((line, i) => (
                <div
                  key={`c-${i}`}
                  className={cn('flex', line.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div className={line.role === 'user' ? userBubble : agentBubble}>
                    {line.content}
                  </div>
                </div>
              ))}
              {restored?.outcome !== undefined ? (
                <div className="flex justify-start">
                  <div className={agentBubble}>
                    {restored.outcome}
                    {restored.txHash !== undefined ? (
                      <a
                        href={`${stellarNetwork.blockExplorerUrl}/tx/${restored.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block text-xs underline underline-offset-2 opacity-70"
                      >
                        View transaction
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {restored !== null &&
              restored.outcome === undefined &&
              Object.keys(restored.proposals).length === 0 ? (
                <p className={systemPill}>No agent discussion was recorded for this intent.</p>
              ) : null}

              {/* What was added to the open intent while it was being decided. */}
              {notes.slice(inSaved.notes).map((note, i) => (
                <div key={`${i}-${note}`} className="flex justify-end">
                  <div className={userBubble}>{note}</div>
                </div>
              ))}
              {/* The questions asked before the agents ran, and the answers. */}
              {clarifying !== null
                ? clarifying.turns
                    .slice(1)
                    .filter((t) => !(t.role === 'assistant' && t.content === ACKNOWLEDGED))
                    .map((turn, i) =>
                      turn.role === 'assistant' ? (
                        <div key={`q-${i}`} className="flex justify-start">
                          <div className={agentBubble}>{turn.content}</div>
                        </div>
                      ) : (
                        <div key={`a-${i}`} className="flex justify-end">
                          <div className={userBubble}>{turn.content}</div>
                        </div>
                      )
                    )
                : null}
              {sequenceNote !== null && restored === null ? (
                <div className="flex justify-start">
                  <div className={agentBubble}>{sequenceNote}</div>
                </div>
              ) : null}
              {cashoutQuestion !== null ? (
                <CashoutCurrencyQuestion
                  question={cashoutQuestion}
                  onChoose={(choice) => {
                    const said = `${choice.name} (${choice.code})`
                    recordLive('user', said)
                    answerCashoutQuestion(choice.code, said)
                  }}
                />
              ) : null}
              {clarifyBusy ? (
                <div className={cn(agentBubble, 'text-muted-foreground w-fit')}>Thinking…</div>
              ) : null}
              {notes.length > 0 && competition.phase === 'competing' ? (
                <p className={systemPill}>Agents are working again with your note.</p>
              ) : null}
              <CompetitionPanel
                state={competition}
                onExecute={handleExecute}
                executingKey={executingKey}
                locked={
                  swap.phase === 'signing' ||
                  swap.phase === 'submitting' ||
                  swap.phase === 'settled' ||
                  chainReviewClosed(
                    chainAction.phase,
                    raceClosed(chainAction.signed === true, chainSequence.settled)
                  )
                }
                directRoute={directFallback}
                reviewable={(key) =>
                  canReview(competition.proposals[key], routesByAgent[key], restored !== null)
                }
                signed={raceClosed(chainAction.requested, chainSequence.settled)}
                {...(slug !== 'stellar' ? { chainName: descriptor.name } : {})}
              />
              {/* Changes to how the recommendation is carried out, offered once
                  the agents have answered and before anything is signed. */}
              {competition.phase === 'decided' &&
              parsed !== null &&
              restored === null &&
              !turnExecuted &&
              !executionInFlight &&
              nairaForm === null ? (
                <StrategyEditor
                  edits={strategy}
                  onChange={setStrategy}
                  defaultSlippageBps={DEFAULT_SLIPPAGE_BPS}
                  receiveBase={(winnerRoute as { destAmount?: string } | undefined)?.destAmount}
                  receiveSymbol={parsed.input.tokenOut}
                  agentMode={
                    competition.winner !== null
                      ? competition.proposals[competition.winner]?.executionMode
                      : undefined
                  }
                  agentRestPriceUsd={
                    competition.winner !== null
                      ? competition.proposals[competition.winner]?.restPriceUsd
                      : undefined
                  }
                  canRest={slug === 'stellar'}
                  onAmount={(amount) =>
                    handleSubmit(
                      amount.startsWith('$')
                        ? `make it ${amount}`
                        : `make it ${amount} ${parsed.input.tokenIn}`
                    )
                  }
                />
              ) : null}

              {/* Said before anything is signed. An order the account cannot
                fund is refused here rather than allowed to rest for hours and
                then fail. */}
              {affordError !== null ? (
                <div className={cn(agentBubble, 'border-dashed')}>
                  <p className="whitespace-pre-line">{affordError}</p>
                </div>
              ) : null}

              {nairaForm !== null ? (
                <NairaPayoutCard
                  key={nairaForm.key}
                  {...(nairaForm.amountXlm !== undefined
                    ? { initialXlm: nairaForm.amountXlm }
                    : {})}
                  {...(swap.usdPrices?.['XLM'] !== undefined
                    ? { xlmPriceUsd: swap.usdPrices['XLM'] }
                    : {})}
                  {...(balances?.xlm !== undefined ? { balanceXlm: balances.xlm } : {})}
                  asset={nairaForm.asset}
                  {...(nairaForm.symbol !== undefined ? { sourceSymbol: nairaForm.symbol } : {})}
                  {...(nairaForm.symbol !== undefined &&
                  balances?.trustlines?.[nairaForm.symbol]?.balance !== undefined
                    ? { balanceOther: balances.trustlines[nairaForm.symbol]?.balance as string }
                    : {})}
                  {...(balances?.trustlines?.['USDC']?.balance !== undefined
                    ? { balanceUsdc: balances.trustlines['USDC'].balance }
                    : {})}
                  onOrder={(order) => {
                    recordStellarTx('The cash-out payment was sent.', order.paymentHash)
                    if (turnId === null) return
                    updateTurn(
                      turnId,
                      {
                        ...(order.paymentHash !== undefined ? { txHash: order.paymentHash } : {}),
                        outcome: cashoutOutcome(order),
                      },
                      { chain: slug, text: message ?? '' }
                    )
                    setTurns(loadTurns(slug))
                  }}
                  {...(nairaForm.asset === 'usdc'
                    ? {}
                    : {
                        onConvertFirst: ({
                          amountXlm,
                          bankCode,
                          accountNumber,
                        }: {
                          amountXlm: number
                          bankCode: string
                          accountNumber: string
                        }) => {
                          // The agents compete on XLM to USDC. The bank details wait
                          // here until one is chosen and the swap is signed.
                          setNairaConvert({ bankCode, accountNumber })
                          setNairaForm(null)
                          setParsed(
                            parseIntent(
                              `Swap ${amountXlm} ${nairaForm.symbol ?? 'XLM'} to USDC`,
                              swap.usdPrices
                            )
                          )
                        },
                      })}
                />
              ) : null}

              {sequence.kind === 'swap-then-naira' &&
              sequence.phase === 'settled' &&
              sequence.naira !== undefined ? (
                <NairaOrderTracker
                  orderId={sequence.naira.orderId}
                  onRetry={sequence.retryPayout}
                />
              ) : null}

              {sequence.kind === 'swap-then-naira' &&
              sequence.phase === 'failed' &&
              sequence.steps[0]?.hash !== undefined ? (
                <button
                  type="button"
                  onClick={sequence.retryPayout}
                  className="border-border hover:border-foreground/40 w-fit rounded-full border px-4 py-2 text-sm transition-colors"
                >
                  Try the payout again
                </button>
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
                <div className={systemPill}>
                  <Sparkles className="h-3.5 w-3.5 animate-pulse motion-reduce:animate-none" />
                  Reading your intent…
                </div>
              ) : null}

              {/* Supplying what the account already holds. One transaction,
                one signature — no sequence to explain. */}
              {supply.phase !== 'idle' ? <SupplyConfirm supply={supply} /> : null}
              {exitWithdraw.phase !== 'idle' ? <WithdrawConfirm withdraw={exitWithdraw} /> : null}
              {exitRepay.phase !== 'idle' ? <BorrowConfirm borrow={exitRepay} /> : null}

              {restored === null ? (
                <ChainSequenceSteps steps={{ ...chainSequence, runNext: pressNextStep }} />
              ) : null}

              {showDirectNote(directFallback, chainAction.phase, chainSequence.settled) ? (
                <p className={systemPill}>
                  The agents were unavailable, so this is the direct route. Nothing has been signed.
                </p>
              ) : null}
              {chainAction.phase !== 'idle' ? (
                <div ref={chainConfirmRef}>
                  <ChainActionConfirm
                    action={chainAction}
                    sequenceSettled={chainSequence.settled}
                    typedStep={typedStep}
                  />
                </div>
              ) : null}
              {ordersShown !== null ? (
                <ChainOrdersCard action={chainAction} asked={ordersShown} />
              ) : null}

              {cashout.session !== null ? (
                <CashoutCard key={cashout.session.key} cashout={cashout} />
              ) : null}

              {/* A leveraged position. One transaction, one signature, and a
                liquidation price to read before it. */}
              {perp.phase !== 'idle' ? <PerpConfirm perp={perp} /> : null}

              {sequence.phase !== 'idle' ? <SequenceConfirm sequence={sequence} /> : null}

              {planExec.phase !== 'idle' ? (
                <PlanConfirm
                  plan={planExec}
                  onSettled={(hash) => {
                    recordStellarTx('The plan settled.', hash)
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
                    recordStellarTx('The order was placed.', hash)
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
              <OpenOrders account={slug === 'stellar' ? address : undefined} />

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
                  onReset={releaseSwap}
                />
              </div>

              {/* The cash-out's second half: the swap has settled and the USDC
                  is in the account, so now the bank details are asked for. */}
              {cashOutFrom !== null ? (
                <div ref={cashOutRef} className="flex scroll-mt-4 flex-col gap-4">
                  <p className={systemPill}>Swap settled. Now cash out your USDC to naira.</p>
                  <NairaPayoutCard
                    key={`after-swap-${cashOutFrom.hash}`}
                    asset="usdc"
                    {...(cashOutUsdc !== undefined && cashOutUsdc > 0
                      ? { initialXlm: cashOutUsdc }
                      : {})}
                    {...(usdcHeld !== undefined ? { balanceUsdc: usdcHeld } : {})}
                    onOrder={(order) => {
                      // An order now exists for this swap's USDC — the thing
                      // the reminder below exists to chase is done, whatever
                      // happens to the order from here.
                      clearPendingCashOut()
                      recordStellarTx('The cash-out payment was sent.', order.paymentHash)
                      if (turnId === null) return
                      updateTurn(
                        turnId,
                        {
                          ...(order.paymentHash !== undefined ? { txHash: order.paymentHash } : {}),
                          outcome: cashoutOutcome(order),
                        },
                        { chain: slug, text: message ?? '' }
                      )
                      setTurns(loadTurns(slug))
                    }}
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Composer. Hidden, not unmounted, behind the history list so a draft survives it. */}
      <div
        className={cn(
          'border-border bg-card/80 shrink-0 border-t p-3 backdrop-blur',
          historyOpen && isConnected && 'hidden'
        )}
      >
        <ComposerInput
          onSubmit={handleSubmit}
          showExamples={message === null && thread.length === 0 && transcript.length === 0}
          {...(clarifying !== null
            ? { placeholder: 'Type your answer…' }
            : message !== null
              ? { placeholder: 'Continue the chat…' }
              : {})}
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
