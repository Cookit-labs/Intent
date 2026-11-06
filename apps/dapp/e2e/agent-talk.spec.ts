import { expect, test, type Page } from '@playwright/test'

/**
 * Agents talking, in the chat, with a fake wallet. The race route is stubbed
 * with the frames a real race sends, so no agent, price or chain is needed.
 */
test.use({ storageState: { cookies: [], origins: [] } })
// The chat page takes over a minute on a dev server's first hit.
test.beforeEach(() => test.slow())

const ADDRESS = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'
const ID = 'race-1'
const AGENTS = [
  { key: 'groq:qwen', name: 'Qwen3.8 27B', gradient: 'a', model: 'qwen/qwen3.8-27b' },
  { key: 'deepseek:flash', name: 'DeepSeek V4 Flash', gradient: 'b', model: 'deepseek-v4-flash' },
]
const [QWEN, DEEPSEEK] = ['groq:qwen', 'deepseek:flash']

async function connectFakeSolanaWallet(page: Page): Promise<void> {
  await page.addInitScript(
    ({ address }) => {
      const account = {
        address,
        publicKey: new Uint8Array(32),
        chains: ['solana:mainnet'],
        features: [],
      }
      const wallet = {
        version: '1.0.0',
        name: 'Fake Solana',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
        chains: ['solana:mainnet'],
        accounts: [account],
        features: {
          'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
          'standard:events': { version: '1.0.0', on: () => () => undefined },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async () => [],
          },
        },
      }
      const register = (api: { register: (w: unknown) => void }): void => {
        api.register(wallet)
      }
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
      window.addEventListener('wallet-standard:app-ready', (e) => {
        register((e as CustomEvent).detail)
      })
    },
    { address: ADDRESS }
  )

  await page.goto('/solana/intents')
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  const steps = page.locator('[data-connect-steps]')
  await steps.getByRole('button', { name: 'Solana' }).click()
  await steps.getByRole('button', { name: 'Fake Solana' }).click()
  await expect(page.getByRole('textbox', { name: 'Describe your intent' })).toBeVisible()
}

const plan = (agent: string, routeId: string | undefined, reasoning: string): object => ({
  agent,
  ...(routeId !== undefined ? { routeId } : {}),
  reasoning,
  projectedAvgPriceUsd: 160,
  projectedSlippagePct: 0.2,
  venues: [],
  sliceCount: 1,
  confidence: 0.5,
  horizonMinutes: 0,
  executionMode: 'fill',
})

const route = (venueId: string, venueName: string): object => ({
  kind: 'chain',
  request: { kind: 'swap', amount: '100', tokenIn: 'USDC', tokenOut: 'SOL' },
  venueId,
  venueName,
  pay: { amount: '100', symbol: 'USDC' },
  receive: { amount: '0.62', symbol: 'SOL' },
  valueInUsd: 100,
  valueOutUsd: 99.8,
})

const started = {
  type: 'competition:started',
  competitionId: ID,
  agents: AGENTS,
  windowSeconds: 30,
}
const take = (agent: string, routeId: string, source: string, reasoning: string): object => ({
  type: 'competition:take',
  competitionId: ID,
  proposal: plan(agent, routeId, reasoning),
  source,
})
const line = (l: object): object => ({ type: 'competition:talk', competitionId: ID, line: l })

const firstTakes = [
  take(QWEN, 'oneclick-1', '1Click', 'It settles in one step, so I would take 1Click.'),
  take(DEEPSEEK, 'jupiter-1', 'Jupiter', 'Jupiter pays 0.62 SOL, the most of the two routes.'),
]

const talk = [
  line({ kind: 'turn', turn: 'ask', agents: [QWEN, DEEPSEEK] }),
  line({ kind: 'reading', agent: QWEN, of: [DEEPSEEK] }),
  line({ kind: 'reading', agent: DEEPSEEK, of: [QWEN] }),
  line({
    kind: 'asked',
    agent: QWEN,
    to: DEEPSEEK,
    text: 'Is that gap worth a route with more steps?',
  }),
  line({ kind: 'turn', turn: 'answer', agents: [DEEPSEEK] }),
  line({
    kind: 'answered',
    agent: DEEPSEEK,
    to: [QWEN],
    text: 'Yes. It pays 0.4% more, and the steps are one signature.',
  }),
  line({ kind: 'turn', turn: 'final', agents: [QWEN, DEEPSEEK] }),
]

const sse = (frames: object[]): string =>
  frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')

async function stubRace(page: Page, frames: object[]): Promise<void> {
  await page.route('**/api/agents/compete', (r) =>
    r.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(frames) })
  )
}

async function say(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Describe your intent' }).fill(text)
  await page.getByRole('button', { name: 'Send intent' }).click()
}

test('the talk reads in order in the chat, then final strategies drop with Review', async ({
  page,
}) => {
  await connectFakeSolanaWallet(page)
  await stubRace(page, [
    started,
    ...firstTakes,
    ...talk,
    line({ kind: 'changed', agent: QWEN }),
    {
      type: 'competition:proposal',
      competitionId: ID,
      proposal: plan(QWEN, 'jupiter-1', 'Persuaded: 0.4% more is worth one signature.'),
      route: route('jupiter', 'Jupiter'),
    },
    {
      type: 'competition:proposal',
      competitionId: ID,
      proposal: plan(DEEPSEEK, 'jupiter-1', 'Jupiter still pays the most.'),
      route: route('jupiter', 'Jupiter'),
    },
    {
      type: 'competition:winner',
      competitionId: ID,
      winner: DEEPSEEK,
      scores: {},
      unanimous: true,
    },
  ])
  await say(page, 'Swap 100 USDC to SOL')

  const asked = page.getByText('Is that gap worth a route with more steps?')
  await expect(page.getByText("Qwen3.8 27B is reading DeepSeek V4 Flash's strategy")).toBeVisible()
  await expect(asked).toBeVisible()
  await expect(page.getByText('Qwen3.8 27B to DeepSeek V4 Flash')).toBeVisible()
  await expect(page.getByText('Yes. It pays 0.4% more')).toBeVisible()
  // Nothing can be reviewed while the talk runs.
  await expect(page.getByRole('button', { name: 'Review' })).toHaveCount(0)
  await page.screenshot({
    path: process.env['TALK_SHOTS']
      ? `${process.env['TALK_SHOTS']}/talk-live.png`
      : 'test-results/talk-live.png',
    fullPage: true,
  })

  await expect(page.getByText('Qwen3.8 27B changed its strategy.')).toBeVisible()
  await expect(page.getByText('Persuaded: 0.4% more is worth one signature.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review' })).toHaveCount(2)
  await expect(page.getByText(/All 2 agents agree/)).toBeVisible()
  // The strategies are what the talk led to, so they are brought into view.
  await expect(page.getByText(/All 2 agents agree/)).toBeInViewport()
  // First takes stay above the final cards.
  await expect(page.getByText('It settles in one step, so I would take 1Click.')).toBeVisible()
  await page.screenshot({
    path: process.env['TALK_SHOTS']
      ? `${process.env['TALK_SHOTS']}/talk-final.png`
      : 'test-results/talk-final.png',
    fullPage: true,
  })
})

test('when every agent holds off there is nothing to sign and no false excuse', async ({
  page,
}) => {
  await connectFakeSolanaWallet(page)
  let prepared = false
  await page.route('**/api/chain/solana/prepare', async (r) => {
    prepared = true
    await r.abort()
  })
  const held = (agent: string, why: string): object => ({
    type: 'competition:proposal',
    competitionId: ID,
    proposal: {
      ...plan(agent, undefined, why),
      held: true,
      projectedAvgPriceUsd: 0,
      projectedSlippagePct: 0,
    },
  })
  await stubRace(page, [
    started,
    ...firstTakes,
    ...talk,
    line({ kind: 'held', agent: QWEN }),
    line({ kind: 'held', agent: DEEPSEEK }),
    held(QWEN, 'Not at this price.'),
    held(DEEPSEEK, 'The route is too thin for this size.'),
  ])
  await say(page, 'Swap 100 USDC to SOL')

  await expect(page.getByText('No agent would do this right now')).toBeVisible()
  await expect(page.getByText('Not at this price.')).toBeVisible()
  await expect(page.getByText('The route is too thin for this size.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign and send' })).toHaveCount(0)
  await expect(page.getByText(/agents were unavailable/i)).toHaveCount(0)
  expect(prepared).toBe(false)
  await page.screenshot({
    path: process.env['TALK_SHOTS']
      ? `${process.env['TALK_SHOTS']}/talk-all-held.png`
      : 'test-results/talk-all-held.png',
    fullPage: true,
  })
})

test('one held agent keeps its reason, with no Review, beside a plan that has one', async ({
  page,
}) => {
  await connectFakeSolanaWallet(page)
  await stubRace(page, [
    started,
    ...firstTakes,
    ...talk,
    line({ kind: 'held', agent: QWEN }),
    {
      type: 'competition:proposal',
      competitionId: ID,
      proposal: { ...plan(QWEN, undefined, 'Not at this price.'), held: true },
    },
    {
      type: 'competition:proposal',
      competitionId: ID,
      proposal: plan(DEEPSEEK, 'jupiter-1', 'Jupiter still pays the most.'),
      route: route('jupiter', 'Jupiter'),
    },
    {
      type: 'competition:winner',
      competitionId: ID,
      winner: DEEPSEEK,
      scores: {},
      unanimous: false,
    },
  ])
  await say(page, 'Swap 100 USDC to SOL')

  await expect(page.getByText('Not at this price.')).toBeVisible()
  await expect(page.getByText('would not do this now', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review' })).toHaveCount(1)
})
