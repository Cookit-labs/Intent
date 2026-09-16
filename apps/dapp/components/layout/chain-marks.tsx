/**
 * Chain marks as inline SVG.
 *
 * The Stellar mark is the official one, traced from the brand asset rather
 * than approximated. An invented placeholder stood here for a while and read
 * as a different network entirely at a glance, which is worse than no logo:
 * a wrong mark is a claim about identity.
 *
 * Filled with `currentColor` so it inherits the surrounding text colour and
 * works on both light and dark grounds without a second file. Kept in sync with the website's Launch dApp menu
 * so a chain looks the same wherever it appears. Inline rather than image files
 * because these render at 16-20px, where a bitmap logo is wasted bytes.
 */
export function ArcMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="11" fill="#6366f1" />
      <path
        d="M12 5.5 18.2 17.4a.7.7 0 0 1-.62 1.03H6.42a.7.7 0 0 1-.62-1.03L12 5.5Z"
        fill="#fff"
      />
      <circle cx="12" cy="14.6" r="1.85" fill="#6366f1" />
    </svg>
  )
}

export function StellarMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 236.36 200" fill="none" aria-hidden="true" className={className}>
      <path
        d="M203,26.16l-28.46,14.5-137.43,70a82.49,82.49,0,0,1-.7-10.69A81.87,81.87,0,0,1,158.2,28.6l16.29-8.3,2.43-1.24A100,100,0,0,0,18.18,100q0,3.82.29,7.61a18.19,18.19,0,0,1-9.88,17.58L0,129.57V150l25.29-12.89,0,0,8.19-4.18,8.07-4.11v0L186.43,55l16.28-8.29,33.65-17.15V9.14Z"
        fill="currentColor"
      />
      <path
        d="M236.36,50,49.78,145,33.5,153.31,0,170.38v20.41l33.27-16.95,28.46-14.5L199.3,89.24A83.45,83.45,0,0,1,200,100,81.87,81.87,0,0,1,78.09,171.36l-1,.53-17.66,9A100,100,0,0,0,218.18,100c0-2.57-.1-5.14-.29-7.68a18.2,18.2,0,0,1,9.87-17.58l8.6-4.38Z"
        fill="currentColor"
      />
    </svg>
  )
}
