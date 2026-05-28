'use client'

// TODO: implement glassmorphic sticky navbar with nav links + CTA
export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-16 border-b border-zinc-800/50 bg-[#09090b]/80 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-6">
        <span className="font-display text-lg font-bold tracking-tight">Intent</span>
        {/* TODO: nav links, CTA button */}
      </div>
    </nav>
  )
}