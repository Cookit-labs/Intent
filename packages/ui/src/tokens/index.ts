export const colors = {
  brand: {
    indigo: '#6366f1',
    cyan: '#06b6d4',
    indigoDim: '#4f46e5',
  },
  surface: {
    base: '#09090b',
    elevated: '#18181b',
    card: '#1c1c1f',
    border: '#27272a',
    borderDim: '#3f3f46',
  },
  text: {
    primary: '#fafafa',
    secondary: '#a1a1aa',
    tertiary: '#71717a',
    accent: '#6366f1',
  },
  status: {
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
    pending: '#a1a1aa',
  },
} as const

export const spacing = {
  px: '1px',
  0: '0',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  6: '1.5rem',
  8: '2rem',
  12: '3rem',
  16: '4rem',
  24: '6rem',
} as const

export const motion = {
  duration: {
    fast: 0.15,
    normal: 0.3,
    slow: 0.5,
    cinematic: 1.2,
  },
  ease: {
    out: [0.0, 0.0, 0.2, 1.0] as number[],
    in: [0.4, 0.0, 1.0, 1.0] as number[],
    inOut: [0.4, 0.0, 0.2, 1.0] as number[],
    spring: { type: 'spring', stiffness: 300, damping: 30 },
  },
} as const