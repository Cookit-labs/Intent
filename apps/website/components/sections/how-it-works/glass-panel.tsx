'use client'

interface GlassPanelProps {
  children: React.ReactNode
  className?: string
  borderRadius?: number
}

/**
 * Cheap glass look for large, mostly-static surfaces: a single backdrop-blur
 * pass instead of GlassSurface's multi-channel SVG displacement filter. That
 * filter is fine on small moving chips (tiny paint area) but on 4 big
 * always-visible panels it's the single biggest cost during Lenis scroll —
 * the compositor has to re-run the whole displacement chain every frame the
 * page transforms. This keeps the blur + shadow + rim-highlight read without
 * the per-frame distortion recompute.
 */
export function GlassPanel({ children, className = '', borderRadius = 16 }: GlassPanelProps) {
  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{
        borderRadius,
        background: 'rgba(255,255,255,0.14)',
        backdropFilter: 'blur(16px) saturate(1.9) brightness(1.06)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.9) brightness(1.06)',
        boxShadow:
          '0 4px 16px rgba(17,17,26,0.06), 0 8px 24px rgba(17,17,26,0.06), 0 16px 56px rgba(17,17,26,0.06), inset 0 1px 0 0 rgba(255,255,255,0.55), inset 0 0 0 1px rgba(255,255,255,0.18)',
        border: '1px solid rgba(255,255,255,0.35)',
      }}
    >
      {children}
    </div>
  )
}
