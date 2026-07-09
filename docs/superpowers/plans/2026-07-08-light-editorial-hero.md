# Light Editorial Hero + Navbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand `apps/website` from its unused dark scaffold to a light editorial theme (`#F5F5EF` bg, Cormorant/Playfair Display/Inter), and build real `Navbar` and `Hero` components replacing their TODO stubs.

**Architecture:** Flip CSS custom properties in `globals.css` from dark to light values, wire the missing semantic color keys (`background`, `foreground`, `border`, etc.) into `tailwind.config.ts` so `@apply`/utility classes actually resolve, swap the two Google fonts in `app/layout.tsx`, then rebuild `Navbar` and `Hero` as plain server components using the new tokens.

**Tech Stack:** Next.js 14.2.4 (App Router), Tailwind CSS 3.4, `next/font/google`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-08-light-editorial-hero-design.md` — follow token values, copy, and component structure exactly as decided there.
- No new npm dependencies (all fonts come from `next/font/google`, already installed).
- Do not modify `apps/dapp` (broken `@intent/ai-agents` workspace ref — separate known issue).
- Do not modify `components/layout/footer.tsx` or any `components/sections/*` other than `hero.tsx` — they stay TODO stubs.
- Run all commands from `apps/website` directly via `npx next build` (not `pnpm build`/`pnpm install`) — the workspace-wide `apps/dapp` breakage makes any pnpm command that resolves the full workspace fail.
- Both `Navbar` and `Hero` are static presentational components — no `'use client'`, no props, no state.

---

## Discovery: pre-existing PostCSS bug

While reviewing the current build output, `.next/static/css/*.css` contained the literal, unprocessed text `@tailwind base;@tailwind components;@tailwind utilities;` and raw `@apply` rules — Tailwind was never actually compiling. Cause: **`apps/website` has no `postcss.config.js`**, so Next's built-in PostCSS pipeline never loads the `tailwindcss`/`autoprefixer` plugins. This predates this plan and affects the entire site, not just the components touched here — it must be fixed first or none of the new utility classes (or any existing ones) will render. Task 1 below fixes it as a prerequisite.

---

### Task 1: Fix PostCSS, flip design tokens, swap fonts

**Files:**

- Create: `apps/website/postcss.config.js`
- Modify: `apps/website/app/globals.css` (full file)
- Modify: `apps/website/tailwind.config.ts` (full file)
- Modify: `apps/website/app/layout.tsx:1-23` (font imports/instances + body className)

**Interfaces:**

- Produces: CSS custom properties `--background`, `--foreground`, `--card`, `--card-foreground`, `--border`, `--input`, `--muted`, `--muted-foreground` now resolve to light values. Tailwind color keys `border`, `input`, `ring`, `background`, `foreground`, `card`, `muted`, `destructive`, `success`, `warning` now exist and map to `hsl(var(--x))`. `fontFamily.display` → Playfair Display, `fontFamily.serif` → Cormorant (new key), `fontFamily.sans` → Inter (unchanged), `fontFamily.mono` → JetBrains Mono (unchanged). `<body>` carries font CSS vars `--font-inter`, `--font-playfair`, `--font-cormorant`, `--font-geist-mono` and classes `bg-background text-foreground`.
- Consumes: nothing (root-level tokens).

- [ ] **Step 1: Create `postcss.config.js`**

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

- [ ] **Step 2: Replace `app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 60 20% 95.7%;
    --foreground: 60 5% 10%;
    --card: 0 0% 100%;
    --card-foreground: 60 5% 10%;
    --border: 60 10% 85%;
    --input: 60 10% 85%;
    --ring: 240 4.9% 83.9%;
    --brand: 239 84% 67%;
    --brand-foreground: 0 0% 98%;
    --accent: 189 94% 43%;
    --accent-foreground: 0 0% 98%;
    --muted: 60 10% 90%;
    --muted-foreground: 60 5% 40%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;
    --success: 142 76% 36%;
    --warning: 38 92% 50%;
    --radius: 0.4rem;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
  ::selection {
    @apply bg-brand/20 text-brand;
  }
}

/* Smooth scrolling handled by Lenis */
html.lenis {
  height: auto;
}
.lenis.lenis-smooth {
  scroll-behavior: auto;
}
.lenis.lenis-smooth [data-lenis-prevent] {
  overscroll-behavior: contain;
}
```

- [ ] **Step 3: Replace `tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        brand: { DEFAULT: '#6366f1', dim: '#4f46e5' },
        accent: '#06b6d4',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        surface: {
          base: '#F5F5EF',
          elevated: '#EFEFE7',
          card: '#FFFFFF',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)'],
        display: ['var(--font-playfair)'],
        serif: ['var(--font-cormorant)'],
        mono: ['var(--font-geist-mono)'],
      },
      animation: {
        'fade-in': 'fadeIn 0.6s ease-out',
        'slide-up': 'slideUp 0.6s ease-out',
        'gradient-x': 'gradientX 6s ease infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        gradientX: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
      },
    },
  },
  plugins: [require('tailwindcss-animate'), require('@tailwindcss/typography')],
}

export default config
```

- [ ] **Step 4: Update `app/layout.tsx` font imports and body class**

Replace the import line and the three font instances above `export const metadata`:

```tsx
import type { Metadata } from 'next'
import { Inter, JetBrains_Mono, Playfair_Display, Cormorant } from 'next/font/google'

import { ThemeProvider } from '../components/providers/theme'
import { SmoothScrollProvider } from '../components/providers/smooth-scroll'

import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

const playfair = Playfair_Display({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-playfair',
  display: 'swap',
})

const cormorant = Cormorant({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
})

const geistMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
})
```

Replace the `<body>` line inside `RootLayout`:

```tsx
      <body
        className={`${inter.variable} ${playfair.variable} ${cormorant.variable} ${geistMono.variable} bg-background text-foreground antialiased`}
      >
```

- [ ] **Step 5: Build and verify PostCSS actually runs**

Run:

```bash
cd apps/website && rm -rf .next && npx next build
```

Expected: ends with `✓ Generating static pages (4/4)`, exit code 0, no type errors.

- [ ] **Step 6: Verify Tailwind directives were processed, not passed through raw**

Run:

```bash
cd apps/website && grep -c "@tailwind base" .next/static/css/*.css
```

Expected: `0` (the raw directive must be gone — if it still appears, PostCSS still isn't running).

Run:

```bash
cd apps/website && grep -o "\.border-border{[^}]*}" .next/static/css/*.css
```

Expected: a real CSS rule like `.border-border{border-color:hsl(var(--border))}` (confirms the color key resolved).

- [ ] **Step 7: Commit**

```bash
git add apps/website/postcss.config.js apps/website/app/globals.css apps/website/tailwind.config.ts apps/website/app/layout.tsx
git commit -m "fix: wire up PostCSS/Tailwind and flip design tokens to light editorial theme"
```

---

### Task 2: Rebuild Navbar

**Files:**

- Modify: `apps/website/components/layout/navbar.tsx` (full file)
- Modify: `apps/website/app/page.tsx:19` (add top padding for fixed navbar height)

**Interfaces:**

- Consumes: Tailwind color/font keys from Task 1 (`bg-background`, `border-border`, `text-muted-foreground`, `bg-success`, `bg-foreground`, `text-background`, `font-sans`).
- Produces: `Navbar` component, default export unchanged (`export function Navbar()`), no props.

- [ ] **Step 1: Replace `components/layout/navbar.tsx`**

```tsx
const NAV_LINKS = [
  { label: 'Docs', href: '#' },
  { label: 'Agents', href: '#' },
  { label: 'Marketplace', href: '#' },
]

export function Navbar() {
  return (
    <nav className="border-border bg-background/80 fixed left-0 right-0 top-0 z-50 h-16 border-b backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-6">
        <span className="font-sans text-lg font-bold tracking-tight">Intent</span>

        <div className="border-border text-muted-foreground hidden items-center gap-2 rounded-full border px-3 py-1 text-xs md:flex">
          <span className="bg-success h-1.5 w-1.5 animate-pulse rounded-full" />
          Arc L1 · Live
        </div>

        <div className="flex items-center gap-6">
          <div className="hidden items-center gap-6 md:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-muted-foreground hover:text-foreground font-sans text-sm transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>
          <a
            href="#"
            className="bg-foreground text-background rounded-full px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
          >
            Book a Demo
          </a>
        </div>
      </div>
    </nav>
  )
}
```

- [ ] **Step 2: Offset page content for the fixed navbar height**

In `apps/website/app/page.tsx`, the `<main>` tag currently has no className. Change:

```tsx
      <main>
```

to:

```tsx
      <main className="pt-16">
```

- [ ] **Step 3: Build and verify**

Run:

```bash
cd apps/website && npx next build
```

Expected: exit code 0, `✓ Generating static pages (4/4)`.

Run:

```bash
cd apps/website && grep -o "Arc L1" .next/server/app/index.html
cd apps/website && grep -o "Book a Demo" .next/server/app/index.html
```

Expected: both print at least one match.

- [ ] **Step 4: Commit**

```bash
git add apps/website/components/layout/navbar.tsx apps/website/app/page.tsx
git commit -m "feat: rebuild navbar with light editorial styling and status pill"
```

---

### Task 3: Rebuild Hero

**Files:**

- Modify: `apps/website/components/sections/hero.tsx` (full file)

**Interfaces:**

- Consumes: Tailwind color/font keys from Task 1 (`font-serif`, `font-display`, `bg-surface-elevated`, `border-border`, `bg-foreground`, `text-background`, `text-muted-foreground`).
- Produces: `Hero` component, `export function Hero()`, no props — matches existing import in `app/page.tsx:1` (`import { Hero } from '../components/sections/hero'`).

- [ ] **Step 1: Replace `components/sections/hero.tsx`**

```tsx
const THUMBNAIL_COUNT = 6

export function Hero() {
  return (
    <section id="hero" className="relative overflow-hidden px-6 py-32">
      <div className="bg-surface-elevated pointer-events-none absolute left-0 top-1/3 hidden h-40 w-40 -translate-x-1/2 rounded-2xl lg:block" />
      <div className="bg-surface-elevated pointer-events-none absolute right-0 top-1/3 hidden h-40 w-40 translate-x-1/2 rounded-2xl lg:block" />

      <div className="mx-auto max-w-3xl text-center">
        <div className="border-border bg-surface-elevated mx-auto mb-8 aspect-square w-44 rounded-full border" />

        <p className="text-muted-foreground font-serif italic">Autonomous Execution Marketplace</p>

        <h1 className="font-display mt-4 text-5xl italic leading-tight md:text-6xl">
          Say what you want.
          <br />
          Let agents fight for the best fill.
        </h1>

        <p className="text-muted-foreground mx-auto mt-6 max-w-xl font-sans">
          Intent is a stablecoin-native marketplace where autonomous AI agents compete to execute
          your trading outcomes — you set the intent, they race to deliver it, settled on Arc L1.
        </p>

        <div className="border-border mx-auto mt-8 w-24 border-t border-dashed" />

        <a
          href="#"
          className="bg-foreground text-background mt-8 inline-block rounded-full px-6 py-3 text-sm font-medium transition-opacity hover:opacity-90"
        >
          Book a Demo
        </a>
      </div>

      <div className="mx-auto mt-20 hidden max-w-5xl gap-4 overflow-x-auto md:flex">
        {Array.from({ length: THUMBNAIL_COUNT }).map((_, i) => (
          <div key={i} className="bg-surface-elevated aspect-video w-48 shrink-0 rounded-lg" />
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Build and verify content**

Run:

```bash
cd apps/website && npx next build
```

Expected: exit code 0, `✓ Generating static pages (4/4)`.

Run:

```bash
cd apps/website && grep -o "Say what you want" .next/server/app/index.html
cd apps/website && grep -c "aspect-video" .next/server/app/index.html
```

Expected: first command prints one match; second prints `6`.

- [ ] **Step 3: Commit**

```bash
git add apps/website/components/sections/hero.tsx
git commit -m "feat: build light editorial hero section"
```

---

### Task 4: Final full verification

**Files:** none (verification only).

- [ ] **Step 1: Full production build from clean state**

```bash
cd apps/website && rm -rf .next && npx next build
```

Expected: exit code 0, `✓ Generating static pages (4/4)`, route `/` listed as `○ (Static)`.

- [ ] **Step 2: Manual browser check**

```bash
cd apps/website && npx next start -p 3000
```

Open `http://localhost:3000` in a browser. Confirm: cream background, serif italic headline, navbar status pill visible, layout holds at both desktop and mobile widths (resize or use dev tools device toolbar). Stop the server (Ctrl+C) when done — this step is manual, not scriptable, per the project's UI-verification requirement.

- [ ] **Step 3: Report**

No commit needed for this task — it's verification-only. If Step 2 surfaces a visual issue, fix it in the relevant task's file and re-run that task's build-verify steps before committing the fix.

---

## Plan Self-Review

- **Spec coverage:** Tokens/typography (Task 1), Navbar (Task 2), Hero (Task 3) all covered. Placeholder image/mascot/thumbnail slots present in Task 3 Step 1 (circle div, two side divs, 6 thumbnail divs). Copy matches spec draft verbatim. Status pill matches spec ("Arc L1 · Live", no clock). `pt-16` offset was a gap in the spec (fixed-nav overlap) — added in Task 2 as a necessary correctness fix, not a scope change.
- **Placeholder scan:** No TBD/TODO left in new code. All code blocks are complete, runnable.
- **Type consistency:** `Hero` and `Navbar` both remain zero-prop, named-export function components, matching their existing import sites in `app/page.tsx` — no signature changes needed there.
- **Out of scope confirmed:** `components/layout/footer.tsx` and all other `components/sections/*` untouched, `apps/dapp` untouched.
