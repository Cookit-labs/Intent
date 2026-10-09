import { describe, expect, it } from 'vitest'

import { tokenBelongsTo } from '../offramp/token-subject'

const ACCOUNT = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'
const OTHER = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ'

function jwt(payload: Record<string, unknown>): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'ES256' })}.${part(payload)}.c2ln`
}

describe('tokenBelongsTo', () => {
  it('accepts a token whose sub is the account', () => {
    expect(tokenBelongsTo(jwt({ sub: ACCOUNT }), ACCOUNT)).toBe(true)
  })

  it('accepts a muxed-memo subject account:memo', () => {
    expect(tokenBelongsTo(jwt({ sub: `${ACCOUNT}:123` }), ACCOUNT)).toBe(true)
  })

  it('refuses a token issued to another account', () => {
    expect(tokenBelongsTo(jwt({ sub: OTHER }), ACCOUNT)).toBe(false)
  })

  it('refuses a subject that merely starts with the account characters but continues', () => {
    expect(tokenBelongsTo(jwt({ sub: `${ACCOUNT}X` }), ACCOUNT)).toBe(false)
  })

  it('refuses a token that is not a jwt, or has no sub', () => {
    expect(tokenBelongsTo('opaque', ACCOUNT)).toBe(false)
    expect(tokenBelongsTo(jwt({}), ACCOUNT)).toBe(false)
  })
})
