import { describe, expect, it, vi } from 'vitest'

import { isExtensionOnlyStack, quietExtensionErrors } from '../extension-console'

const SLUSH = 'chrome-extension://opcgpfmipidbgpenhmajoajpbobppdil/dapp-interface.js'
const APP = 'https://localhost:3001/_next/static/chunks/app/page.js'

const fromExtension = `Error
    at <unknown> (${SLUSH}:7:636)
    at x (${SLUSH}:7:1175)
    at Array.forEach (<anonymous>)
    at n (${SLUSH}:7:9861)`

const throughExtension = `Error
    at <unknown> (${SLUSH}:7:636)
    at connectTo (${APP}:5:2)`

const appCallbackRunByExtension = `Error
    at onChange (${APP}:5:2)
    at emit (${SLUSH}:7:636)`

describe('isExtensionOnlyStack', () => {
  it('matches a stack made only of extension frames', () => {
    expect(isExtensionOnlyStack(fromExtension)).toBe(true)
  })

  it('leaves alone an error the app is part of', () => {
    expect(isExtensionOnlyStack(throughExtension)).toBe(false)
    expect(isExtensionOnlyStack(appCallbackRunByExtension)).toBe(false)
  })

  it('leaves alone a stack that names no extension, or none at all', () => {
    expect(isExtensionOnlyStack(`Error\n    at b (${APP}:2:2)`)).toBe(false)
    expect(isExtensionOnlyStack('Error')).toBe(false)
    expect(isExtensionOnlyStack(undefined)).toBe(false)
  })
})

describe('quietExtensionErrors', () => {
  it('sends extension noise to debug and everything else through', () => {
    const error = vi.fn()
    const debug = vi.fn()
    const target = { error, debug }
    let stack = fromExtension
    quietExtensionErrors(target, () => stack)

    target.error('wallet noise')
    expect(error).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('wallet noise')

    stack = throughExtension
    target.error('real problem')
    expect(error).toHaveBeenCalledWith('real problem')
  })

  it('passes everything through when the real stack is from the caller, not an extension', () => {
    const error = vi.fn()
    const debug = vi.fn()
    const target = { error, debug }
    quietExtensionErrors(target)
    target.error('from a test file')
    expect(error).toHaveBeenCalledWith('from a test file')
    expect(debug).not.toHaveBeenCalled()
  })
})
