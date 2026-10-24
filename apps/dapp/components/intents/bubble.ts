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
