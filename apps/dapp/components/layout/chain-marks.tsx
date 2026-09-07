/**
 * Chain marks as inline SVG. Kept in sync with the website's Launch dApp menu
 * so a chain looks the same wherever it appears. Inline rather than image files
 * because these render at 16-20px, where a bitmap logo is wasted bytes.
 */
export function ArcMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="11" fill="#6366f1" />
      <path d="M12 5.5 18.2 17.4a.7.7 0 0 1-.62 1.03H6.42a.7.7 0 0 1-.62-1.03L12 5.5Z" fill="#fff" />
      <circle cx="12" cy="14.6" r="1.85" fill="#6366f1" />
    </svg>
  )
}

export function StellarMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="11" fill="#0f0f14" />
      <path d="M5.2 8.7 18.8 15.3M5.2 15.3 18.8 8.7" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3.4" fill="#0f0f14" stroke="#fff" strokeWidth="1.6" />
    </svg>
  )
}
