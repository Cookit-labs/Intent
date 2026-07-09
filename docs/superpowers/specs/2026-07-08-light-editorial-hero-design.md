# Light Editorial Hero + Navbar + Site Rebrand

Date: 2026-07-08

## Context

`apps/website` is scaffolded but unimplemented — `Hero`, `Navbar`, and all `components/sections/*` are TODO stubs. Current design tokens ([globals.css](../../../apps/website/app/globals.css), [tailwind.config.ts](../../../apps/website/tailwind.config.ts)) are hardcoded dark (`#09090b` bg, indigo/cyan brand).

Reference: a personal portfolio hero (screenshot provided by user) — centered layout, circular photo/video, italic serif headline, dashed divider, CTA pill button, mascot illustrations, bottom thumbnail strip. User wants this layout language applied to Intent, with:

- Fonts: Cormorant, Inter, Playfair Display
- Background: `#F5F5EF`
- Images (photo/video, mascots, thumbnail strip) ignored for now — reserved as placeholder slots

## Decisions

- **Scope: whole-site rebrand.** Color/font tokens flip globally, not just the Hero. Other sections stay TODO stubs but will inherit the new tokens whenever built.
- **Navbar included** in this pass, redesigned to match the reference's structure.
- **Image slots kept as empty placeholder blocks** (not omitted) so the layout grid is ready when real assets land.
- **Copy is drafted**, not literal — adapted from existing site metadata (`Intent — Autonomous Execution Marketplace`, "stablecoin-native execution marketplace where autonomous AI agents compete...").
- **No literal clock widget.** Reference's status pill + clock becomes a single Intent-relevant status pill (protocol/network status), no time display.

## 1. Design tokens & typography

### `app/globals.css`

Flip `:root` CSS variables from dark to light:

| Token                                                            | Current                     | New                                  |
| ---------------------------------------------------------------- | --------------------------- | ------------------------------------ |
| `--background`                                                   | `240 10% 3.9%` (near-black) | `60 20% 95.7%` (`#F5F5EF`)           |
| `--foreground`                                                   | `0 0% 98%`                  | near-black ink, e.g. `60 5% 10%`     |
| `--card`                                                         | `240 10% 3.9%`              | `0 0% 100%` (white)                  |
| `--card-foreground`                                              | `0 0% 98%`                  | same ink as `--foreground`           |
| `--border`                                                       | `240 3.7% 15.9%`            | light warm gray, e.g. `60 10% 85%`   |
| `--input`                                                        | `240 3.7% 15.9%`            | same as `--border`                   |
| `--muted`                                                        | `240 3.7% 15.9%`            | light warm gray, e.g. `60 10% 90%`   |
| `--muted-foreground`                                             | `240 5% 64.9%`              | mid gray, e.g. `60 5% 40%`           |
| `--brand`, `--accent`, `--destructive`, `--success`, `--warning` | unchanged                   | unchanged (already work on light bg) |

`::selection` stays `bg-brand/20 text-brand`.

### `tailwind.config.ts`

- `fontFamily.sans` stays `['var(--font-inter)']`.
- `fontFamily.display` → drop Space Grotesk, becomes `['var(--font-playfair)']` (Playfair Display — big italic headline).
- New `fontFamily.serif` → `['var(--font-cormorant)']` (Cormorant — eyebrow labels, small italic accents).
- `fontFamily.mono` unchanged (JetBrains Mono, already fixed in a prior session).
- `colors.surface`: invert — `base: '#F5F5EF'`, `elevated: '#EFEFE7'`, `card: '#FFFFFF'`.
- `colors.brand`/`colors.accent` unchanged.

### `app/layout.tsx`

- Replace `Space_Grotesk` import with `Playfair_Display` and `Cormorant` from `next/font/google`, both with `style: ['normal', 'italic']` (headline/eyebrow use italic).
- `body` className drops hardcoded `bg-[#09090b] text-zinc-50` in favor of `bg-background text-foreground` (now driven by the CSS vars above) — also fixes the pre-existing hardcode that bypassed the token system.

## 2. Navbar (`components/layout/navbar.tsx`)

Fixed top bar, `bg-background/80 backdrop-blur-md`, bottom hairline `border-border`.

Layout (`flex justify-between items-center`, `max-w-7xl` container):

- **Left:** wordmark — "Intent" in `font-sans font-bold`.
- **Center-left:** status pill — small dot (`bg-success`, `animate-pulse`) + text `Arc L1 · Live`, pill shape (`rounded-full border border-border px-3 py-1 text-xs`).
- **Right:** nav links (`Docs`, `Agents`, `Marketplace` — `font-sans text-sm text-muted-foreground hover:text-foreground`) + CTA button `Book a Demo` (`bg-foreground text-background rounded-full px-4 py-2 text-sm font-medium`).

Mobile: status pill and nav links collapse/hide below `md`; wordmark + CTA remain.

## 3. Hero (`components/sections/hero.tsx`)

Centered column, `py-32` (generous), `max-w-3xl mx-auto text-center`.

Top to bottom:

1. Circular media placeholder — empty `div`, `aspect-square w-44 rounded-full border border-border bg-surface-elevated`, centered. No image logic yet.
2. Eyebrow line — `font-serif italic text-muted-foreground` (Cormorant): "Autonomous Execution Marketplace"
3. Headline — `font-display italic text-5xl md:text-6xl leading-tight` (Playfair Display), two lines: "Say what you want. Let agents fight for the best fill."
4. Subhead — `font-sans text-muted-foreground max-w-xl mx-auto`: "Intent is a stablecoin-native marketplace where autonomous AI agents compete to execute your trading outcomes — you set the intent, they race to deliver it, settled on Arc L1."
5. Dashed divider — thin `border-t border-dashed border-border w-24 mx-auto`.
6. CTA button — same pill style as navbar CTA, larger: "Book a Demo".
7. Side illustration placeholders — two empty `rounded-2xl` boxes, `absolute` positioned at hero's left/right edges, `hidden lg:block` (hidden below `lg` to avoid layout crowding on smaller viewports).
8. Bottom thumbnail strip placeholder — `flex gap-4 overflow-x-auto`, ~6 empty `aspect-video rounded-lg bg-surface-elevated` boxes, `hidden md:flex`.

All placeholder blocks use `surface-elevated` bg with no image/alt logic — pure layout reservations, so dropping in real assets later is a content swap, not a restructure.

## Testing / verification

- No business logic — visual/layout change only. Verify via `pnpm build` (typecheck + static generation) and manual browser check (`pnpm dev`) at desktop + mobile widths.
- No unit tests needed (static presentational components, no state/props beyond what's hardcoded).

## Out of scope

- Actual photo/video, mascot illustrations, thumbnail images — placeholder slots only, per user request.
- Other sections (`Agents`, `Marketplace`, `Architecture`, etc.) — remain TODO stubs, inherit new tokens whenever built later.
- `apps/dapp` broken `@intent/ai-agents` workspace reference — separate known issue, not addressed here.
- `Book a Demo` CTA destination/routing — dapp isn't a route in this app; use `#` as placeholder href until routing exists.
