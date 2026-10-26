/**
 * The two sides of the thread.
 *
 * The user speaks in light purple on the right; agents in white (purple-black
 * in dark mode) on the left. The corner nearest the speaker is tucked, which is
 * what makes a run of bubbles read as one voice.
 */
export const userBubble =
  'bg-bubble-me text-bubble-me-foreground max-w-[80%] whitespace-pre-line rounded-[22px] rounded-br-md px-4 py-2.5 text-sm'

export const agentBubble =
  'bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border max-w-[85%] whitespace-pre-line rounded-[22px] rounded-bl-md border px-4 py-2.5 text-sm leading-relaxed shadow-[0_1px_2px_rgb(0_0_0/0.04)]'

/** A note from the room rather than from either side: centred and quiet. */
export const systemPill =
  'bg-muted/70 text-muted-foreground mx-auto flex w-fit max-w-[90%] items-center justify-center gap-2 rounded-2xl px-3 py-1.5 text-center text-xs'

/**
 * A tool in the thread (a swap to sign, a payout to fill) rather than a
 * message: the agents' surface in light mode, near-black in dark.
 */
export const toolCard =
  'bg-bubble-agent text-bubble-agent-foreground border-bubble-agent-border flex flex-col rounded-3xl border p-5 shadow-[0_1px_3px_rgb(0_0_0/0.05)] dark:border-white/[0.06] dark:bg-[#0F0F0F] dark:text-foreground dark:shadow-[0_12px_40px_-16px_rgb(0_0_0/0.7)]'

/** A box inside a tool card: an amount, a field, a summary. */
export const toolPanel =
  'border-bubble-agent-border bg-background/70 rounded-2xl border dark:border-white/[0.07] dark:bg-[#121212]'
