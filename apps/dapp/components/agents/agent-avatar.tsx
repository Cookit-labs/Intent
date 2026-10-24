import { cn } from '@intent/ui'

import { agentAvatarUri } from '../../lib/agents/persona'

/**
 * An agent's pixel character, read from its key.
 *
 * `seed` is the agent key, so the same model is the same character wherever it
 * appears.
 */
export function AgentAvatar({
  seed,
  name,
  className,
  pending = false,
}: {
  seed: string
  name: string
  className?: string
  /** Washed out while the agent has not answered yet. */
  pending?: boolean
}): JSX.Element {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={agentAvatarUri(seed)}
      alt={name}
      className={cn(
        'ring-background shrink-0 rounded-full ring-2 [image-rendering:pixelated]',
        pending && 'animate-pulse opacity-50 motion-reduce:animate-none',
        className
      )}
    />
  )
}
