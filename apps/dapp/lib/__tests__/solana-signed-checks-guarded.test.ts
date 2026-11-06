import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' || name === '__tests__' || name.startsWith('.')
        ? []
        : sources(path)
    }
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/** Signed Solana bytes handed to a check as they came from the wallet, guards and all. */
const RAW_SIGNED = /transaction:\s*[\w.]*\bsignedTransaction\b/

describe('every check of a signed Solana transaction', () => {
  it('first leaves out the wallet’s own Lighthouse guards', () => {
    // Phantom adds them before signing. A check that reads the raw bytes refuses every Phantom user,
    // as the cash-out deposit did on 6 November after the chain submit route was fixed alone.
    const raw = [join(ROOT, 'app'), join(ROOT, 'lib')]
      .flatMap(sources)
      .filter((file) => RAW_SIGNED.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file))
    expect(raw).toEqual([])
  })

  it('would have caught the two places that read them raw', () => {
    expect(RAW_SIGNED.test("{ family: 'solana', transaction: signed.signedTransaction }")).toBe(
      true
    )
    expect(
      RAW_SIGNED.test(
        "{ family: 'solana', transaction: withoutWalletGuards(signed.signedTransaction) }"
      )
    ).toBe(false)
  })
})
