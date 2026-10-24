import { cn } from '@intent/ui'

import { agentPersona, type Persona } from '../../lib/agents/persona'

function Antenna({ kind, ink }: { kind: Persona['antenna']; ink: string }): JSX.Element | null {
  switch (kind) {
    case 'ball':
      return (
        <g stroke={ink} strokeWidth={2} strokeLinecap="round">
          <line x1={20} y1={11} x2={20} y2={6.5} />
          <circle cx={20} cy={5} r={2} fill={ink} stroke="none" />
        </g>
      )
    case 'twin':
      return (
        <g stroke={ink} strokeWidth={2} strokeLinecap="round">
          <line x1={15} y1={11.5} x2={12.5} y2={6.5} />
          <line x1={25} y1={11.5} x2={27.5} y2={6.5} />
          <circle cx={12} cy={5.5} r={1.6} fill={ink} stroke="none" />
          <circle cx={28} cy={5.5} r={1.6} fill={ink} stroke="none" />
        </g>
      )
    case 'spike':
      return <path d="M17 11.5 L20 4.5 L23 11.5 Z" fill={ink} />
    default:
      return null
  }
}

function Eyes({ kind, ink }: { kind: Persona['eyes']; ink: string }): JSX.Element {
  switch (kind) {
    case 'ovals':
      return (
        <g fill={ink}>
          <ellipse cx={15.5} cy={20} rx={1.8} ry={2.6} />
          <ellipse cx={24.5} cy={20} rx={1.8} ry={2.6} />
        </g>
      )
    case 'visor':
      return (
        <g>
          <rect x={11.5} y={17.5} width={17} height={5} rx={2.5} fill={ink} />
          <rect x={14} y={19} width={4} height={2} rx={1} fill="white" opacity={0.85} />
        </g>
      )
    case 'cyclops':
      return (
        <g>
          <circle cx={20} cy={20} r={3.8} fill="white" />
          <circle cx={20.6} cy={20.4} r={2} fill={ink} />
        </g>
      )
    case 'happy':
      return (
        <g stroke={ink} strokeWidth={2} strokeLinecap="round" fill="none">
          <path d="M13 21 Q15.5 17.5 18 21" />
          <path d="M22 21 Q24.5 17.5 27 21" />
        </g>
      )
    default:
      return (
        <g fill={ink}>
          <circle cx={15.5} cy={20} r={2} />
          <circle cx={24.5} cy={20} r={2} />
        </g>
      )
  }
}

function Mouth({ kind, ink }: { kind: Persona['mouth']; ink: string }): JSX.Element | null {
  switch (kind) {
    case 'smile':
      return (
        <path
          d="M16 25.5 Q20 28.5 24 25.5"
          stroke={ink}
          strokeWidth={1.8}
          strokeLinecap="round"
          fill="none"
        />
      )
    case 'flat':
      return (
        <line
          x1={17}
          y1={26.5}
          x2={23}
          y2={26.5}
          stroke={ink}
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      )
    case 'o':
      return <circle cx={20} cy={26.5} r={1.6} fill={ink} />
    case 'grin':
      return (
        <g>
          <rect x={15.5} y={25} width={9} height={3.5} rx={1.75} fill={ink} />
          <line x1={18.5} y1={25} x2={18.5} y2={28.5} stroke="white" strokeWidth={0.8} />
          <line x1={21.5} y1={25} x2={21.5} y2={28.5} stroke="white" strokeWidth={0.8} />
        </g>
      )
    default:
      return null
  }
}

/**
 * An agent's face: a small robot whose shape and colour are read from its key.
 *
 * `seed` is the agent key. Older callers that only had a gradient still pass
 * it, and the key is what both were derived from.
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
  const p = agentPersona(seed)
  const bgA = `hsl(${p.hue} 70% 62%)`
  const bgB = `hsl(${(p.hue + 50) % 360} 75% 72%)`
  const face = `hsl(${p.hue} 60% 96%)`
  const ink = `hsl(${p.hue} 45% 22%)`
  const id = `av-${seed.replace(/[^a-z0-9]/gi, '')}`

  const head =
    p.head === 'round' ? (
      <circle cx={20} cy={22} r={10.5} fill={face} />
    ) : p.head === 'square' ? (
      <rect x={9.5} y={11.5} width={21} height={20} rx={5} fill={face} />
    ) : (
      <rect x={11} y={10.5} width={18} height={22.5} rx={8} fill={face} />
    )

  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        'inline-flex shrink-0 overflow-hidden rounded-full',
        pending && 'animate-pulse opacity-50 motion-reduce:animate-none',
        className
      )}
    >
      <svg viewBox="0 0 40 40" className="h-full w-full">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={bgA} />
            <stop offset="100%" stopColor={bgB} />
          </linearGradient>
        </defs>
        <rect width={40} height={40} fill={`url(#${id})`} />
        <Antenna kind={p.antenna} ink={face} />
        {head}
        <Eyes kind={p.eyes} ink={ink} />
        {p.blush ? (
          <g fill={`hsl(${(p.hue + 330) % 360} 80% 75%)`} opacity={0.7}>
            <circle cx={12.5} cy={25} r={1.8} />
            <circle cx={27.5} cy={25} r={1.8} />
          </g>
        ) : null}
        <Mouth kind={p.mouth} ink={ink} />
      </svg>
    </span>
  )
}
