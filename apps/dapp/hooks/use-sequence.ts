'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { useChain } from '../providers/chain-provider'
import { useWallet } from './use-wallet'
import { lendingVenueName } from '../lib/lend/venues'
import { checkRecipient, pinRecipient } from '../lib/names/address-book'
import type { PinStatus } from '../lib/names/address-book'
import type { ResolvedRecipient } from '../lib/names/resolve'
import type { AnchorId } from '../lib/offramp/anchors'
import { ANCHORS } from '../lib/offramp/anchors'
import { capToLimits, offrampSizeWarning, withdrawStepLabel } from '../lib/offramp/labels'
import type { WithdrawLimits } from '../lib/offramp/sep24'
import { sendStepLabel, sentLabel } from '../lib/send/labels'
import { fromBaseUnits } from '../lib/swap/assets'
import { blendPositionUrl } from '../lib/swap/contract-registry'
import { balanceOf, deliveredByBalanceChange } from '../lib/swap/delivered-balance'
import type { LedgerPreview } from '../lib/swap/preview'
import { FAILURE_MESSAGES } from '../lib/swap/submit'
import { useOfframpSession } from './use-offramp-session'

/**
 * Signing several transactions in order.
 *
 * Distinct from `use-plan-execution`, and the difference is forced by the
 * protocol rather than chosen. A plan is one transaction that Stellar executes
 * atomically: every step or none. **Soroban permits exactly one operation per
 * transaction** — verified on testnet twice — so a swap and a lending step
 * (a Blend supply, or a DeFindex deposit) cannot share a signature, and a
 * sequence is genuinely several transactions signed one at a time.
 *
 * That changes what honesty requires. A plan can promise atomicity; a sequence
 * cannot, so it must instead show every step before the first signature and say
 * exactly where the user is if they stop partway.
 *
 * **Stopping is a normal outcome, not a failure.** Someone who signs the swap
 * and declines the supply holds XLM. That is a position, not a stuck state, and
 * the UI must say so rather than implying the sequence broke.
 *
 * The compensation for losing atomicity is real: step two is priced against
 * what step one *actually delivered*, rather than against an estimate an atomic
 * version would have had to guess in advance.
 *
 * **Steps advance on their own.** Approving the sequence approves all of it, so
 * once the first signature is given the next wallet prompt follows without
 * another button. That is a UX choice, not a safety one: the whole plan is
 * still shown before the first signature, which is where consent actually
 * happens. Declining any prompt stops the run, and the wallet remains the last
 * word on every individual transaction.
 */

export type SequencePhase =
  | 'idle'
  | 'building'
  | 'review'
  | 'signing'
  | 'submitting'
  | 'settled'
  | 'stopped'
  | 'failed'
  // The anchor's part of an offramp, between the swap settling and the
  // payment being buildable. Distinct phases because each is something
  // different for the user to do: sign a challenge, complete the anchor's
  // page, or read what the anchor named before signing the payment.
  | 'authenticating'
  | 'anchor-interactive'
  | 'anchor-ready'
  // The anchor ended the withdrawal before any payment was sent. Nothing was
  // lost, and this is its own state so the card can say exactly that.
  | 'anchor-declined'

export interface SequenceStep {
  /** What this step does, in words, for the review list. */
  label: string
  /** Set once this step confirms. */
  hash?: string
  explorerUrl?: string
  /**
   * Where the *result* of this step can be seen, when that is somewhere other
   * than a block explorer.
   *
   * A supply's explorer link proves the transaction happened; it does not show
   * the position it created, its balance, or the rate it earns. Those are what
   * someone who just lent actually wants.
   */
  positionUrl?: string
  /** What the `positionUrl` link says. "View position on Blend" when absent. */
  positionLabel?: string
  /**
   * Where this step put the funds, by name, for history.
   *
   * "Blend" or "DeFindex" on a lending step. History used to infer Blend
   * from a position link with no anchor; with two venues, the step says.
   */
  venue?: string
  /** What the step actually delivered, in base units. Known only after it settles. */
  delivered?: string
  anchor?: { id: string; transactionId: string; moreInfoUrl?: string; lastStatus?: string }
}

export interface SequenceState {
  phase: SequencePhase
  steps: SequenceStep[]
  /** Which step is being signed, or would be next. */
  current: number
  /** The envelope awaiting signature, when there is one. */
  xdr?: string
  error?: string
  /**
   * Set when the next step should sign itself without another click.
   *
   * True only for steps after the first: the opening signature is always
   * deliberate, because that is the moment the whole plan was approved.
   */
  autoAdvance?: boolean
  kind?: SequenceRequest['kind']
  /**
   * Which lending venue a swap-then-lend supplies, by id.
   *
   * The review card shows that venue's risks once the supply is the step in
   * hand, and the two venues' risks are not the same list.
   */
  lendVenue?: string
  /**
   * Something worth saying before the first signature, that does not stop it.
   *
   * A size the anchor will refuse or cap is the case this exists for: the user
   * should read it while the trade is still theirs to cancel, rather than
   * discover it after a swap has settled.
   */
  warning?: string
  /**
   * What the server read from the anchor, shown verbatim on the review card
   * so the user sees the destination the payment will actually go to.
   */
  offramp?: {
    anchorName: string
    destination: string
    memo: string
    memoType: string
    amount: string
    moreInfoUrl?: string
    interactiveUrl?: string
    anchorStatus?: string
    /** Whether the automatic popup actually opened, so the card can say. */
    popupOpen?: boolean
  }
  /**
   * What the server resolved the recipient to, shown verbatim on the review
   * card, and what this browser's address book has to say about it.
   */
  send?: SendReview
}

/** A payment as the server built it, for the review card. */
export interface SendReview {
  /** As typed. */
  recipient: string
  kind: ResolvedRecipient['kind']
  /** What the server resolved it to. */
  address: string
  resolvedOn?: ResolvedRecipient['resolvedOn']
  /** Display units, as built — a dollar amount has been sized by now. */
  amount: string
  asset: string
  memo?: string
  memoType?: string
  preview?: LedgerPreview
  /** Whether this browser has paid the name before, and where it pointed then. */
  pin: PinStatus
}

/** A payment of an asset already held. One step, one signature. */
export interface SendOnly {
  kind: 'send-only'
  asset: string
  /** Display units, or dollars when `amountIsUsd`. */
  amount: string
  amountIsUsd?: boolean
  /** As typed: an address, a `.xlm` name or `name*domain`. Resolved on the server. */
  recipient: string
  memo?: string
}

/** A swap, then a payment of whatever it delivered. */
export interface SwapThenSend {
  kind: 'swap-then-send'
  quote: unknown
  /** The symbol the swap delivers, so its arrival can be measured. */
  receiveSymbol: string
  recipient: string
  memo?: string
  swapLabel?: string
}

/** A swap, then a supply of whatever it delivered. */
export interface SwapThenLend {
  kind: 'swap-then-lend'
  /** The symbol the swap delivers, so its arrival can be measured. */
  receiveSymbol: string
  /**
   * The route the chosen agent picked, built through whichever venue it names.
   *
   * A quote rather than a bare action, because the venue is the whole point.
   * Building every sequence as a classic path payment ignored the agent's
   * choice and, on USDC to XLM, sent a trade down a path delivering a third of
   * what the agent had quoted — so it reverted on its own slippage floor every
   * time.
   */
  quote: unknown
  /** The reserve's asset, as a contract id. Blend only; DeFindex resolves its vault from `receiveSymbol`. */
  lendAsset: string
  /** 'blend' or 'defindex', as `lib/lend/venues.ts` names them. */
  venue: string
  /** Shown in review before the first signature. */
  swapLabel?: string
}

/** A swap into USDC, then a withdrawal of whatever it delivered to fiat. */
export interface SwapThenOfframp {
  kind: 'swap-then-offramp'
  quote: unknown
  /** Always USDC today; carried so the balance delta can be measured. */
  receiveSymbol: string
  anchor: AnchorId
  swapLabel?: string
  /**
   * What the chosen route expects the swap to deliver, in display units.
   *
   * An estimate, and said as one: it is what the anchor's limits are checked
   * against before the first signature, because a swap sized outside them
   * would settle and then have nowhere to go.
   */
  estimatedReceive?: string
  /** The anchor's live limits, for the size warning before signature one. */
  limits?: WithdrawLimits
}

/** A withdrawal of USDC already held. One step, one signature. */
export interface OfframpOnly {
  kind: 'offramp-only'
  anchor: AnchorId
  /** Display units. Absent means the anchor asks. */
  amount?: string
}

export type SequenceRequest = SwapThenLend | SwapThenOfframp | OfframpOnly | SendOnly | SwapThenSend

export interface Sequence extends SequenceState {
  /** Builds the first step and shows the whole sequence. Does not sign. */
  prepare: (request: SequenceRequest) => void
  /** Signs and submits the step now awaiting signature. */
  confirm: () => void
  /** Stops after what has already settled, deliberately. */
  stop: () => void
  reset: () => void
  /** Re-opens the anchor's page during `anchor-interactive`. */
  reopenAnchor: () => void
}

const EMPTY: SequenceState = { phase: 'idle', steps: [], current: 0 }

export function useSequence(): Sequence {
  const { adapter } = useChain()
  const { address, isConnected } = useWallet()
  const [state, setState] = useState<SequenceState>(EMPTY)
  const [request, setRequest] = useState<SequenceRequest | undefined>(undefined)
  const offramp = useOfframpSession()
  // `begin` and `reset` are stable identities, so depending on them rather than
  // on `offramp` itself keeps the effects and callbacks below from being
  // rebuilt on every anchor poll. `reopen` is not stable — it closes over
  // `interactiveUrl` and so re-identifies once, when the anchor's page opens —
  // but nothing here depends on it beyond the passthrough at the bottom.
  const {
    begin: beginOfframp,
    reopen: reopenOfframp,
    reset: resetOfframp,
    forget: forgetOfframp,
  } = offramp

  // Which anchor transaction the payment has already been built for. Guards the
  // `ready` branch below, which would otherwise re-run: `ready` is terminal, so
  // every later render of that effect still sees it.
  const builtFor = useRef<string | undefined>(undefined)

  // What the DeFindex deposit was built for, so its submit can be re-checked
  // against the same asset and amount the user reviewed. Set when the deposit
  // is built, read when it is submitted; a ref because `confirm` is rebuilt
  // between the two and must not read a stale closure.
  const lendPlan = useRef<{ asset: string; amount: string } | undefined>(undefined)

  // What the payment was built for, so its submit asks the server to check the
  // same figures, and so the address book can be told where the name pointed
  // once the payment has settled. Same reasoning as `lendPlan`.
  const sendPlan = useRef<
    { asset: string; amount: string; address: string; memo?: string } | undefined
  >(undefined)

  // Mirrors `state.phase` for the guard in the anchor effect below, which must
  // read the sequence's *current* phase from inside a closure that would
  // otherwise capture a stale one — and must not depend on `state.phase`, or
  // the effect would re-run on every phase change and re-enter its branches.
  const sequencePhaseRef = useRef<SequencePhase>(state.phase)
  useEffect(() => {
    sequencePhaseRef.current = state.phase
  }, [state.phase])

  const reset = useCallback(() => {
    setState(EMPTY)
    setRequest(undefined)
    builtFor.current = undefined
    lendPlan.current = undefined
    sendPlan.current = undefined
    resetOfframp()
  }, [resetOfframp])

  /**
   * Ends the sequence where it stands.
   *
   * Reported as `stopped` rather than `failed`, because nothing went wrong. The
   * distinction is the whole point: a user holding the asset from step one made
   * a choice, and calling that a failure would misdescribe their position.
   *
   * The anchor session goes with it. Left running, its polling continued after
   * "Stop here" and the mirroring effect below — keyed on the session's phase —
   * overwrote `stopped` with `anchor-ready` and fired a build for a payment the
   * user had just declined.
   */
  const stop = useCallback(() => {
    setState((s) => ({ ...s, phase: 'stopped' }))
    builtFor.current = undefined
    resetOfframp()
  }, [resetOfframp])

  /**
   * Builds the payment, resolving the recipient on the server, and shows what
   * it resolved to before asking for a signature.
   *
   * No `autoAdvance`, for the offramp's reason and one more: the destination
   * is somebody else's account, and when the address book says the name has
   * moved, the card holds the signature until that has been read and ticked.
   * The server is the only thing that resolves the name; nothing here tells
   * it an address.
   */
  const buildSend = useCallback(
    async (
      signer: string,
      req: SendOnly | SwapThenSend,
      stepIndex: number,
      amount: string,
      amountIsUsd: boolean
    ): Promise<void> => {
      setState((s) => ({ ...s, phase: 'building' }))
      const afterSwap = stepIndex > 0
      const asset = req.kind === 'send-only' ? req.asset : req.receiveSymbol

      let built: {
        xdr?: string
        expectation?: { amount: string; asset: { code: string }; memo?: string; memoType?: string }
        resolved?: ResolvedRecipient
        preview?: LedgerPreview
        error?: string
      }
      try {
        const res = await fetch('/api/send/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: signer,
            asset,
            amount,
            amountIsUsd,
            recipient: req.recipient,
            ...(req.memo !== undefined ? { memo: req.memo } : {}),
          }),
        })
        built = (await res.json()) as typeof built
      } catch (e) {
        setState((s) => ({
          ...s,
          phase: 'failed',
          error:
            'The payment could not be prepared: ' +
            (e instanceof Error ? e.message : 'the network did not answer') +
            (afterSwap
              ? '. The swap went through; you are holding the asset.'
              : '. Nothing was signed.'),
        }))
        return
      }

      const { xdr, expectation, resolved } = built
      if (xdr === undefined || expectation === undefined || resolved === undefined) {
        setState((s) => ({
          ...s,
          phase: 'failed',
          error:
            (built.error ?? 'The payment could not be built.') +
            (afterSwap
              ? ' The swap went through; you are holding the asset.'
              : ' Nothing was signed.'),
        }))
        return
      }

      sendPlan.current = {
        asset: expectation.asset.code,
        amount: expectation.amount,
        address: resolved.address,
        ...(expectation.memo !== undefined ? { memo: expectation.memo } : {}),
      }

      const label = sendStepLabel(expectation.amount, expectation.asset.code, req.recipient)
      const review: SendReview = {
        recipient: req.recipient,
        kind: resolved.kind,
        address: resolved.address,
        ...(resolved.resolvedOn !== undefined ? { resolvedOn: resolved.resolvedOn } : {}),
        amount: expectation.amount,
        asset: expectation.asset.code,
        ...(expectation.memo !== undefined ? { memo: expectation.memo } : {}),
        ...(expectation.memoType !== undefined ? { memoType: expectation.memoType } : {}),
        ...(built.preview !== undefined ? { preview: built.preview } : {}),
        // Compared against this browser's record, never used in place of the
        // server's answer: the card says whether the name moved, that is all.
        pin: checkRecipient(req.recipient, resolved.address),
      }

      setState((s) => ({
        ...s,
        phase: 'review',
        current: stepIndex,
        xdr,
        send: review,
        steps: afterSwap
          ? s.steps.map((step, i) => (i === stepIndex ? { ...step, label } : step))
          : [{ label }],
      }))
    },
    []
  )

  const prepare = useCallback(
    (req: SequenceRequest) => {
      if (!isConnected || address === undefined) {
        setState({ ...EMPTY, phase: 'failed', error: 'Connect a wallet to run this sequence.' })
        return
      }
      const signer = address

      async function run(): Promise<void> {
        setRequest(req)

        if (req.kind === 'offramp-only') {
          // One step. The anchor's part starts immediately; the payment is
          // built once the anchor is ready.
          setState({
            ...EMPTY,
            kind: req.kind,
            phase: 'authenticating',
            current: 0,
            steps: [{ label: withdrawStepLabel(req.anchor, req.amount) }],
          })
          beginOfframp(req.anchor, req.amount)
          return
        }

        if (req.kind === 'send-only') {
          // One step. The recipient is resolved and the payment built on the
          // server, and the card shows what it resolved to before any
          // signature.
          setState({ ...EMPTY, kind: req.kind, phase: 'building' })
          await buildSend(signer, req, 0, req.amount, req.amountIsUsd === true)
          return
        }

        setState({ ...EMPTY, kind: req.kind, phase: 'building' })

        try {
          // What step two is depends on where the proceeds are going: a
          // supply to a lending venue, or a payment to the anchor sized to
          // whatever arrives.
          //
          // For DeFindex this is also the moment the deployment is asked
          // whether it can reach the venue at all. The browser cannot see
          // server keys, and a venue this deployment lacks has to be refused
          // here, before any signature, rather than found missing after the
          // swap has settled and left the user holding the asset with nowhere
          // planned for it to go.
          let second: SequenceStep
          if (req.kind === 'swap-then-lend') {
            const name = lendingVenueName(req.venue)
            second = { label: `Supply the result to ${name}`, venue: name }
            if (req.venue === 'defindex') {
              const res = await fetch(
                `/api/lend/defindex/vault?asset=${encodeURIComponent(req.receiveSymbol)}`
              )
              const info = (await res.json()) as { apy?: number; error?: string }
              if (!res.ok) {
                setState({
                  ...EMPTY,
                  kind: req.kind,
                  phase: 'failed',
                  error: `${info.error ?? 'DeFindex is not available on this deployment.'} Nothing was signed.`,
                })
                return
              }
              // Said as a testnet figure, because it is one: a trailing
              // 7-day yield on synthetic liquidity, not a forecast.
              second.label =
                `Deposit the result into DeFindex’s ${req.receiveSymbol} vault` +
                (info.apy !== undefined ? ` (about ${info.apy}% APY, a testnet figure)` : '')
            }
          } else if (req.kind === 'swap-then-send') {
            second = { label: sendStepLabel(undefined, req.receiveSymbol, req.recipient) }
          } else {
            second = { label: withdrawStepLabel(req.anchor) }
          }

          // The same endpoint an ordinary swap uses, so a sequence inherits its
          // venue dispatch: a Soroswap route builds a router call, a classic
          // route builds a path payment. The plan endpoint could only ever
          // build the latter, which is why an agent's Soroswap quote became a
          // Horizon trade that could not meet its own floor.
          const res = await fetch('/api/swap/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: signer, quote: req.quote }),
          })
          const built = (await res.json()) as { xdr?: string; error?: string }

          if (built.xdr === undefined) {
            setState({
              ...EMPTY,
              phase: 'failed',
              error: built.error ?? 'Could not build the first step.',
            })
            return
          }

          // Both steps are named before the first signature. Showing only the
          // step being signed would let someone approve step one without
          // knowing a second was coming.
          setState({
            kind: req.kind,
            phase: 'review',
            current: 0,
            xdr: built.xdr,
            steps: [{ label: req.swapLabel ?? 'Swap' }, second],
            ...(req.kind === 'swap-then-lend' ? { lendVenue: req.venue } : {}),
          })

          // Said before the first signature rather than after the swap
          // settles. The anchor's minimum and maximum are facts the user can
          // still act on here; past the signature they are only bad news.
          if (req.kind === 'swap-then-offramp' && req.estimatedReceive !== undefined) {
            const warning = offrampSizeWarning(req.estimatedReceive, req.limits)
            if (warning !== undefined) setState((s) => ({ ...s, warning }))
          }
        } catch {
          setState({ ...EMPTY, phase: 'failed', error: 'Could not reach the network.' })
        }
      }

      void run()
    },
    [address, isConnected, beginOfframp, buildSend]
  )

  /**
   * Builds the supply, sized to what the swap actually delivered.
   *
   * The amount is a parameter rather than a stored figure precisely because it
   * is not knowable until the previous step confirms.
   *
   * Two builders, chosen by venue. Blend's takes the reserve's contract id
   * and builds the envelope here; DeFindex's takes the ticker, resolves the
   * vault server-side, and admits an envelope its API built. Both hand back
   * one unsigned transaction, which is all this hook needs to know.
   */
  const buildLend = useCallback(
    async (signer: string, req: SwapThenLend, amount: string): Promise<void> => {
      setState((s) => ({ ...s, phase: 'building' }))

      const isDefindex = req.venue === 'defindex'
      if (isDefindex) lendPlan.current = { asset: req.receiveSymbol, amount }

      const res = await fetch(isDefindex ? '/api/lend/defindex/build' : '/api/lend/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isDefindex
            ? { account: signer, asset: req.receiveSymbol, amount }
            : { account: signer, asset: req.lendAsset, amount }
        ),
      })
      const built = (await res.json()) as { xdr?: string; bTokens?: string; error?: string }

      if (built.xdr === undefined) {
        // The supply failing does not undo the swap. The user holds the asset,
        // which is why this reports where they are rather than a bare error.
        setState((s) => ({
          ...s,
          phase: 'failed',
          error:
            built.error ??
            'The swap went through, but the supply could not be built. You are holding the asset.',
        }))
        return
      }

      // Assigned by spread rather than named, because strict optional
      // properties reject an explicit `undefined` where the key is optional.
      const envelope = built.xdr
      // Marked ready rather than awaiting a click. The effect below picks this
      // up and raises the next wallet prompt, so the user signs twice instead
      // of clicking twice and signing twice.
      setState((s) => ({ ...s, phase: 'review', current: 1, xdr: envelope, autoAdvance: true }))
    },
    []
  )

  /**
   * Builds the payment once the anchor is ready, and shows what the server
   * read before asking for a signature.
   *
   * No `autoAdvance`: unlike a supply, the destination here is a third
   * party's account, and the user should read it — the anchor's account and
   * memo, as the server read them — before the wallet prompt.
   */
  const buildOfframp = useCallback(
    async (
      signer: string,
      anchor: AnchorId,
      transactionId: string,
      token: string
    ): Promise<void> => {
      setState((s) => ({ ...s, phase: 'building' }))

      let built: {
        xdr?: string
        destination?: string
        memo?: string
        memoType?: string
        amount?: string
        anchorStatus?: string
        moreInfoUrl?: string
        error?: string
        code?: string
      }
      try {
        const res = await fetch('/api/offramp/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: signer, anchor, transactionId, authToken: token }),
        })
        built = (await res.json()) as typeof built
      } catch (e) {
        // Caught rather than left to reject, because this runs from an effect
        // as `void buildOfframp(...)`: an unhandled rejection would leave the
        // phase at `anchor-ready` with no error and no way forward.
        setState((s) => ({
          ...s,
          phase: 'failed',
          error:
            'The payment could not be prepared: ' +
            (e instanceof Error ? e.message : 'the network did not answer') +
            '. You are holding the USDC; start the withdrawal again.',
        }))
        // Released so a later `ready` can build this same transaction again.
        // The withdrawal is still open at the anchor — nothing was sent, and
        // the failure was on the way there rather than a decision about it.
        builtFor.current = undefined
        return
      }

      const { xdr, destination, memo } = built
      if (xdr === undefined || destination === undefined || memo === undefined) {
        // Nothing was sent. A `declined` code means the anchor ended it, which
        // is its own outcome rather than a fault.
        const declined = built.code === 'declined'
        setState((s) => ({
          ...s,
          phase: declined ? 'anchor-declined' : 'failed',
          error: built.error ?? 'The withdrawal could not be built. You are holding the USDC.',
        }))
        // Released on a failure, which may yet succeed on a retry; kept on a
        // decline, where the anchor has ended this withdrawal and rebuilding
        // it would be asking for a payment it no longer expects.
        if (!declined) builtFor.current = undefined
        return
      }

      setState((s) => ({
        ...s,
        phase: 'review',
        xdr,
        offramp: {
          // Spread first so what the interactive phase learned — the anchor's
          // page URL, and whether its popup opened — survives the build rather
          // than being replaced by the subset the build itself returns.
          ...s.offramp,
          anchorName: ANCHORS[anchor].name,
          destination,
          memo,
          memoType: built.memoType ?? '',
          amount: built.amount ?? '',
          ...(built.moreInfoUrl !== undefined ? { moreInfoUrl: built.moreInfoUrl } : {}),
          ...(built.anchorStatus !== undefined ? { anchorStatus: built.anchorStatus } : {}),
        },
      }))
    },
    []
  )

  // The anchor session drives the sequence's anchor phases. Kept as an effect
  // rather than callbacks so a reload that resumes the session lands in the
  // right phase without re-running `prepare`.
  const anchorStepIndex = request?.kind === 'offramp-only' ? 0 : 1
  const {
    phase: offrampPhase,
    transactionId: offrampTransactionId,
    token: offrampToken,
    interactiveUrl: offrampInteractiveUrl,
    status: offrampStatus,
    error: offrampError,
    popupOpen: offrampPopupOpen,
  } = offramp
  useEffect(() => {
    if (
      request === undefined ||
      (request.kind !== 'swap-then-offramp' && request.kind !== 'offramp-only')
    )
      return
    if (address === undefined) return
    // The sequence has already ended. A session still winding down — a poll in
    // flight when "Stop here" was pressed — must not drag a terminal sequence
    // back into an anchor phase and build a payment nobody asked for. Read
    // through a ref so the guard is the phase *now*, not the one captured when
    // this effect was created.
    const settled = sequencePhaseRef.current
    if (settled === 'stopped' || settled === 'failed' || settled === 'settled') return

    if (offrampPhase === 'authenticating' || offrampPhase === 'starting') {
      setState((s) =>
        s.phase === 'authenticating'
          ? s
          : { ...s, phase: 'authenticating', current: anchorStepIndex }
      )
    } else if (offrampPhase === 'interactive') {
      setState((s) => ({
        ...s,
        phase: 'anchor-interactive',
        current: anchorStepIndex,
        offramp: {
          ...(s.offramp ?? {
            anchorName: ANCHORS[request.anchor].name,
            destination: '',
            memo: '',
            memoType: '',
            amount: '',
          }),
          ...(offrampInteractiveUrl !== undefined ? { interactiveUrl: offrampInteractiveUrl } : {}),
          ...(offrampStatus !== undefined ? { anchorStatus: offrampStatus } : {}),
          // Said so the card can offer its own button when the browser blocked
          // the automatic window, which is the common case. Always a boolean on
          // the session hook, so it is assigned rather than spread.
          popupOpen: offrampPopupOpen,
        },
      }))
    } else if (
      offrampPhase === 'ready' &&
      offrampTransactionId !== undefined &&
      offrampToken !== undefined
    ) {
      // Built once per anchor transaction, guarded by a ref for the same reason
      // `advancedFor` below is: React re-runs effects it has already run — in
      // StrictMode on mount, and after any remount — and `ready` is terminal,
      // so every one of those re-runs still sees it. Unguarded, a second
      // `/api/offramp/build` would overwrite the envelope and the destination
      // under a user who may already be signing, and drag `review` back to
      // `building` mid-read.
      if (builtFor.current === offrampTransactionId) return
      builtFor.current = offrampTransactionId
      setState((s) => ({ ...s, phase: 'anchor-ready', current: anchorStepIndex }))
      void buildOfframp(address, request.anchor, offrampTransactionId, offrampToken)
    } else if (offrampPhase === 'declined') {
      setState((s) => ({
        ...s,
        phase: 'anchor-declined',
        error: offrampError ?? 'The anchor ended this withdrawal.',
      }))
    } else if (offrampPhase === 'failed') {
      setState((s) => ({
        ...s,
        phase: 'failed',
        error: offrampError ?? 'The anchor could not be reached.',
      }))
    }
  }, [
    offrampPhase,
    offrampTransactionId,
    offrampToken,
    offrampInteractiveUrl,
    offrampStatus,
    offrampError,
    offrampPopupOpen,
    request,
    address,
    anchorStepIndex,
    buildOfframp,
  ])

  const confirm = useCallback(() => {
    const envelope = state.xdr
    if (envelope === undefined || address === undefined || request === undefined) return
    const signer = address
    const req = request
    const stepIndex = state.current

    // Which step pays the anchor: the only one in an offramp-only run, the
    // second in a swap-then-offramp.
    const isOfframpStep =
      (req.kind === 'offramp-only' && stepIndex === 0) ||
      (req.kind === 'swap-then-offramp' && stepIndex === 1)

    // Which step deposits into DeFindex: the second of a swap-then-lend whose
    // venue is DeFindex. Its envelope came from DeFindex's API and goes back
    // through DeFindex's relay, so it has its own submit route, which
    // re-checks it against the asset and amount the deposit was built for.
    const isDefindexStep =
      req.kind === 'swap-then-lend' && req.venue === 'defindex' && stepIndex === 1

    // Which step pays a recipient: the only one in a send-only run, the
    // second in a swap-then-send. Its submit route resolves the name again.
    const isSendStep =
      (req.kind === 'send-only' && stepIndex === 0) ||
      (req.kind === 'swap-then-send' && stepIndex === 1)

    async function run(): Promise<void> {
      // Captured before the swap runs, so what it delivers can be measured as
      // a difference. A router reports its output as a contract return value
      // that Horizon does not expose, so the account is the only honest source.
      const before =
        stepIndex === 0 && req.kind !== 'offramp-only' && req.kind !== 'send-only'
          ? await balanceOf(signer, req.receiveSymbol)
          : undefined

      setState((s) => {
        const next: SequenceState = { ...s, phase: 'signing' }
        // Consumed here, so a re-render cannot raise a second prompt for the
        // same step.
        delete next.autoAdvance
        return next
      })

      const signed = await adapter.signTransaction?.({ xdr: envelope as string, address: signer })
      if (signed === undefined) {
        setState((s) => ({ ...s, phase: 'failed', error: 'This chain cannot run sequences yet.' }))
        return
      }
      if (!signed.ok) {
        if (signed.reason === 'rejected') {
          // Declining step one abandons the sequence; declining step two leaves
          // a real position from step one. Different outcomes, so they are
          // reported differently.
          setState((s) => ({ ...s, phase: stepIndex === 0 ? 'review' : 'stopped' }))
          return
        }
        setState((s) => ({
          ...s,
          phase: 'failed',
          error: signed.detail ?? 'The wallet could not sign this step.',
        }))
        return
      }

      setState((s) => ({ ...s, phase: 'submitting' }))

      const endpoint = isSendStep
        ? '/api/send/submit'
        : isOfframpStep
          ? '/api/offramp/submit'
          : stepIndex === 0
            ? '/api/plan/submit'
            : isDefindexStep
              ? '/api/lend/defindex/submit'
              : '/api/lend/submit'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          // The send endpoint takes the recipient as typed and the figures the
          // payment was built for; it resolves the name itself and is never
          // told an address. The anchor's endpoint needs the withdrawal this
          // payment belongs to, and the token that proves the account may act
          // on it. `isOfframpStep` narrows `req` to the two offramp kinds,
          // which is what carries the `anchor` field — no cast needed.
          isSendStep
            ? {
                signedXdr: signed.signedXdr,
                account: signer,
                recipient: (req as SendOnly | SwapThenSend).recipient,
                asset: sendPlan.current?.asset,
                amount: sendPlan.current?.amount,
                ...(sendPlan.current?.memo !== undefined ? { memo: sendPlan.current.memo } : {}),
              }
            : isOfframpStep
              ? {
                  signedXdr: signed.signedXdr,
                  account: signer,
                  anchor: req.anchor,
                  transactionId: offrampTransactionId,
                  authToken: offrampToken,
                }
              : isDefindexStep
                ? {
                    signedXdr: signed.signedXdr,
                    account: signer,
                    asset: lendPlan.current?.asset,
                    amount: lendPlan.current?.amount,
                  }
                : { signedXdr: signed.signedXdr, account: signer }
        ),
      })
      const result = (await res.json()) as {
        ok?: boolean
        hash?: string
        explorerUrl?: string
        delivered?: string
        reason?: keyof typeof FAILURE_MESSAGES
      }

      if (result.ok !== true) {
        setState((s) => ({
          ...s,
          phase: 'failed',
          error:
            result.reason !== undefined
              ? FAILURE_MESSAGES[result.reason]
              : 'That step did not go through.',
        }))
        return
      }

      // The withdrawal is paid, so its stored token and transaction id have
      // done their work. Left behind, a second withdrawal to the same anchor
      // inside the token's fifteen minutes resumed this finished one — the
      // anchor would be asked about a transaction already settled rather than
      // being asked to start a new one.
      if (isOfframpStep) forgetOfframp()

      setState((s) => {
        const steps = s.steps.map((step, i) =>
          i === stepIndex
            ? {
                ...step,
                ...(result.hash !== undefined ? { hash: result.hash } : {}),
                ...(result.explorerUrl !== undefined ? { explorerUrl: result.explorerUrl } : {}),
                ...(result.delivered !== undefined ? { delivered: result.delivered } : {}),
                // Only the supply has somewhere else worth looking. A swap is
                // fully described by its transaction; a position is not. For a
                // withdrawal, the place worth looking is the anchor's own page
                // about this transaction, where the fiat side plays out.
                ...(isOfframpStep
                  ? {
                      // Read from the updater's own `s`, not from the closure:
                      // this runs after a balance read, a wallet signature and
                      // a submit, by which time a captured `state` is stale.
                      ...(s.offramp?.moreInfoUrl !== undefined
                        ? {
                            positionUrl: s.offramp.moreInfoUrl,
                            positionLabel: 'Track at the anchor',
                          }
                        : {}),
                      // The anchor's own id for this transaction, so a reload
                      // — or Open positions — can ask it directly where the
                      // withdrawal stands, rather than relying on whatever
                      // this tab's session already knew.
                      ...(offrampTransactionId !== undefined
                        ? {
                            anchor: {
                              id: (req as SwapThenOfframp | OfframpOnly).anchor,
                              transactionId: offrampTransactionId,
                              ...(s.offramp?.moreInfoUrl !== undefined
                                ? { moreInfoUrl: s.offramp.moreInfoUrl }
                                : {}),
                              // No `lastStatus`. Naming one here would be
                              // stating an anchor fact the anchor has not
                              // said — the payment has been broadcast, and
                              // what the anchor makes of it is only known
                              // once it is asked. `pendingWithdrawals`
                              // already reads a missing status as pending,
                              // and the first `refresh()` fills it in.
                            },
                          }
                        : {}),
                    }
                  : // DeFindex has no position page this app knows of, so
                    // its step carries no link rather than Blend's. A payment
                    // left nothing behind anywhere.
                    stepIndex > 0 && !isDefindexStep && !isSendStep
                    ? { positionUrl: blendPositionUrl() }
                    : {}),
                // Re-said in the past tense, which is what history shows.
                ...(isSendStep && sendPlan.current !== undefined
                  ? {
                      label: sentLabel(
                        sendPlan.current.amount,
                        sendPlan.current.asset,
                        (req as SendOnly | SwapThenSend).recipient
                      ),
                    }
                  : {}),
              }
            : step
        )
        const done = stepIndex >= s.steps.length - 1
        const next: SequenceState = { ...s, steps, phase: done ? 'settled' : 'building' }
        delete next.xdr
        return next
      })

      // The step that makes a sequence worth the second signature: the supply
      // is sized to what arrived, not to what was predicted.
      //
      // Measured from the account rather than read from the transaction. The
      // result only carries a delivered amount for a classic path payment, and
      // an agent that picks a Soroban router produces neither — which stopped
      // the sequence after a swap that had actually succeeded.
      // Pinned only once the payment settled, so the book records where a name
      // pointed when money actually went there.
      if (isSendStep && sendPlan.current !== undefined) {
        pinRecipient((req as SendOnly | SwapThenSend).recipient, sendPlan.current.address)
      }

      if (stepIndex === 0 && req.kind !== 'offramp-only' && req.kind !== 'send-only') {
        const delivered =
          before !== undefined
            ? await deliveredByBalanceChange(signer, req.receiveSymbol, before)
            : result.delivered

        if (delivered === undefined) {
          setState((s) => ({
            ...s,
            phase: 'failed',
            error:
              'The swap settled, but how much it delivered could not be read. ' +
              'You are holding the asset; act on it manually rather than guessing an amount.',
          }))
          return
        }

        if (req.kind === 'swap-then-lend') {
          await buildLend(signer, req, delivered)
        } else if (req.kind === 'swap-then-send') {
          // Sized to what arrived, like the supply; held for a read, like the
          // anchor's payment, because the destination is somebody else's.
          await buildSend(signer, req, 1, fromBaseUnits(delivered), false)
        } else {
          // The anchor is asked for what arrived, and the label is re-said
          // with the real figure rather than the estimate.
          //
          // Capped at the anchor's maximum, which is what the pre-signature
          // warning promised: "only the maximum will be withdrawn; the rest
          // stays in your wallet". Asking for the whole of an over-sized
          // delivery would be refused by the anchor after the swap had already
          // settled — the outcome that warning exists to avoid.
          const display = fromBaseUnits(delivered)
          const capped = capToLimits(display, req.limits)
          const wasCapped = capped !== display
          const label = wasCapped
            ? withdrawStepLabel(req.anchor, capped) +
              " (the anchor's maximum; the rest stays in your wallet)"
            : withdrawStepLabel(req.anchor, display)
          setState((s) => ({
            ...s,
            steps: s.steps.map((step, i) => (i === 1 ? { ...step, label } : step)),
          }))
          beginOfframp(req.anchor, capped)
        }
      }
    }

    void run().catch(() => {
      setState((s) => ({ ...s, phase: 'failed', error: 'Something went wrong signing this step.' }))
    })
  }, [
    state.xdr,
    state.current,
    address,
    adapter,
    request,
    buildLend,
    buildSend,
    beginOfframp,
    forgetOfframp,
    offrampTransactionId,
    offrampToken,
  ])

  // Raises the next wallet prompt once a later step is built and ready.
  //
  // Guarded by a ref rather than by the phase alone: React may render the same
  // state twice, and a duplicate prompt for the same envelope would ask the
  // user to sign a transaction they have already seen.
  const advancedFor = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (state.autoAdvance !== true || state.phase !== 'review' || state.xdr === undefined) return
    if (advancedFor.current === state.xdr) return
    advancedFor.current = state.xdr
    confirm()
  }, [state.autoAdvance, state.phase, state.xdr, confirm])

  const reopenAnchor = useCallback(() => reopenOfframp(), [reopenOfframp])

  return { ...state, prepare, confirm, stop, reset, reopenAnchor }
}
