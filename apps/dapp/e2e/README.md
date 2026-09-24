# Browser smoke tests

Playwright drives the dapp through what a first visit touches: the root redirect and the composer, the Apps and History pages, the chain switcher, and one intent submitted without a wallet. Nothing is configured on purpose — no wallet, no model key, no database — and `playwright.config.ts` blanks the provider keys so a local `.env.local` cannot change the outcome.

Run from `apps/dapp`:

    npx playwright install chromium   # once per machine
    pnpm test:e2e                     # next build, next start on :3006, run the suite
    npx playwright show-report        # after a failure

On Windows `next build` fails in the `/icon` prerender, so run the suite against the dev server instead: `E2E_SERVER=dev pnpm test:e2e` (PowerShell: `$env:E2E_SERVER='dev'; pnpm test:e2e`).

CI runs the same suite in the `e2e` job with `E2E_SERVER=start`, against the build the `typescript` job uploaded, and keeps the HTML report as an artifact when it fails.
