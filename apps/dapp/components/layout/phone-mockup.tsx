'use client'

import { useRef, useState, type PointerEvent } from 'react'

import { PhoneScreen } from './phone-screen'

const WIDTH = 150
const HEIGHT = 304
const RADIUS = 32
const BEZEL = 5
const DEPTH = 15
const SCREEN_WIDTH = 390
const REST = { x: 7, y: -32 }

/** Titanium: light catches the middle of the edge and falls off toward both sides. */
const EDGE = 'linear-gradient(90deg, #55565b 0%, #c4c5cb 45%, #6a6b71 100%)'

/**
 * A phone in real 3D.
 *
 * The body is a stack of identical rounded slices pushed back one pixel at a
 * time, which is what gives the edge its thickness when the device turns; a
 * single tilted rectangle would stay flat. The front carries the bezel, the
 * screen, the island and a pane of glare. It leans toward the pointer while
 * the pointer is over it, and rests at a fixed angle otherwise. Nothing
 * moves on its own, and nothing moves at all for a reader who asked for less
 * motion.
 */
export function PhoneMockup({ className }: { className?: string }): JSX.Element {
  const stage = useRef<HTMLDivElement>(null)
  const [tilt, setTilt] = useState(REST)

  function lean(e: PointerEvent<HTMLDivElement>): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const box = stage.current?.getBoundingClientRect()
    if (box === undefined) return
    const dx = (e.clientX - (box.left + box.width / 2)) / (box.width / 2)
    const dy = (e.clientY - (box.top + box.height / 2)) / (box.height / 2)
    setTilt({
      x: REST.x - Math.max(-1, Math.min(1, dy)) * 8,
      y: REST.y + Math.max(-1, Math.min(1, dx)) * 16,
    })
  }

  return (
    <div
      ref={stage}
      onPointerMove={lean}
      onPointerLeave={() => setTilt(REST)}
      className={`relative flex justify-center ${className ?? ''}`}
      style={{ perspective: 900 }}
    >
      <div
        className="relative"
        style={{
          width: WIDTH,
          height: HEIGHT,
          transformStyle: 'preserve-3d',
          transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          transition: 'transform 180ms ease-out',
        }}
      >
        {Array.from({ length: DEPTH }, (_, i) => (
          <div
            key={i}
            className="absolute inset-0"
            style={{
              borderRadius: RADIUS,
              background: EDGE,
              transform: `translateZ(${-i}px)`,
            }}
          />
        ))}

        {/* Side keys sit on the edge, halfway through the body. */}
        {[
          { side: 'left', top: 64, height: 22 },
          { side: 'left', top: 98, height: 34 },
          { side: 'left', top: 140, height: 34 },
          { side: 'right', top: 110, height: 52 },
        ].map((key) => (
          <div
            key={`${key.side}-${key.top}`}
            className="absolute rounded-sm"
            style={{
              [key.side]: -2,
              top: key.top,
              width: 3,
              height: key.height,
              background: '#6c6d73',
              transform: `translateZ(${-DEPTH / 2}px)`,
            }}
          />
        ))}

        <div
          className="absolute inset-0"
          style={{
            borderRadius: RADIUS,
            background: '#0a0a0c',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)',
            transform: 'translateZ(0.5px)',
          }}
        >
          <div
            className="absolute overflow-hidden"
            style={{
              inset: BEZEL,
              borderRadius: RADIUS - BEZEL,
            }}
          >
            <div
              style={{
                width: SCREEN_WIDTH,
                transformOrigin: 'top left',
                transform: `scale(${(WIDTH - BEZEL * 2) / SCREEN_WIDTH})`,
              }}
            >
              <PhoneScreen />
            </div>
          </div>

          <div
            className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black"
            style={{ top: BEZEL + 6, width: 42, height: 12 }}
          />

          <div
            className="pointer-events-none absolute"
            style={{
              inset: BEZEL,
              borderRadius: RADIUS - BEZEL,
              background:
                'linear-gradient(118deg, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0.06) 30%, transparent 46%)',
            }}
          />
        </div>
      </div>

      <div
        className="pointer-events-none absolute -bottom-3 left-1/2 -translate-x-1/2 rounded-full"
        style={{
          width: WIDTH * 0.8,
          height: 18,
          background: 'radial-gradient(closest-side, rgba(0,0,0,0.35), transparent)',
          filter: 'blur(4px)',
        }}
      />
    </div>
  )
}
