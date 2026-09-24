import { beforeEach, describe, expect, it, vi } from 'vitest'

import { checkRecipient, pinRecipient } from '../names/address-book'

/**
 * The address book: what a name resolved to last time, kept in this browser.
 *
 * It exists for one warning. A name is a pointer somebody else controls, and
 * the day it points somewhere new is the day to look twice. The book never
 * decides anything — the server resolves every payment fresh — it only says
 * whether the answer changed.
 */

const G1 = 'GBGFEZ5QZFLQJTTCQUYWTJBGZN6QEVFF57F3LVD2MF7MRYWUNKFBJWIV'
const G2 = 'GARSCEEOGZ4MGOTZLQHOKJGOPK455N6SHD7SAEFFHIJDAV445GFWJGHD'

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  })
})

describe('checkRecipient', () => {
  it('calls a name it has never seen new', () => {
    expect(checkRecipient('deon.xlm', G1)).toEqual({ status: 'new' })
  })

  it('calls a name that resolved to the same address known', () => {
    pinRecipient('deon.xlm', G1)
    expect(checkRecipient('deon.xlm', G1)).toEqual({ status: 'known' })
  })

  it('names the previous address when a pinned name has moved', () => {
    pinRecipient('deon.xlm', G1)
    const status = checkRecipient('deon.xlm', G2)
    expect(status.status).toBe('changed')
    if (status.status !== 'changed') return
    expect(status.previous).toBe(G1)
    expect(new Date(status.pinnedAt).getTime()).not.toBeNaN()
  })

  it('keys names without regard to case', () => {
    pinRecipient('Deon.xlm', G1)
    expect(checkRecipient('deon.XLM', G1)).toEqual({ status: 'known' })
  })

  it('keeps names apart', () => {
    pinRecipient('deon.xlm', G1)
    expect(checkRecipient('alice*lobstr.co', G1)).toEqual({ status: 'new' })
  })

  it('stores under one versioned key', () => {
    pinRecipient('deon.xlm', G1)
    expect([...store.keys()]).toEqual(['intent.addressbook.v1'])
  })
})

describe('pinRecipient', () => {
  it('overwrites a moved name with the new address', () => {
    pinRecipient('deon.xlm', G1)
    pinRecipient('deon.xlm', G2)
    expect(checkRecipient('deon.xlm', G2)).toEqual({ status: 'known' })
  })

  it('never pins a raw address', () => {
    // A key is its own address; there is nothing to compare it against later,
    // and a book full of keys would only bury the names.
    pinRecipient(G1, G1)
    expect(store.size).toBe(0)
    expect(checkRecipient(G1, G1)).toEqual({ status: 'new' })
  })
})

describe('the memo counts as much as the address', () => {
  // An exchange's federation answer is one pooled account for everybody and a
  // memo saying whose deposit this is. A changed memo with the same address
  // is a redirect, and "same address as last time" would be reassurance at
  // exactly the wrong moment.
  it('calls a same-address, different-memo answer changed, and says it was the memo', () => {
    pinRecipient('alice*lobstr.co', G1, '4242')
    const status = checkRecipient('alice*lobstr.co', G1, '9999')
    expect(status.status).toBe('changed')
    if (status.status !== 'changed') return
    expect(status.what).toBe('memo')
    expect(status.previous).toBe(G1)
    expect(status.previousMemo).toBe('4242')
  })

  it('calls the same address and memo known', () => {
    pinRecipient('alice*lobstr.co', G1, '4242')
    expect(checkRecipient('alice*lobstr.co', G1, '4242')).toEqual({ status: 'known' })
  })

  it('calls a memo appearing where there was none changed', () => {
    pinRecipient('alice*lobstr.co', G1)
    expect(checkRecipient('alice*lobstr.co', G1, '4242').status).toBe('changed')
  })

  it('says the address moved when it did, whatever the memo', () => {
    pinRecipient('alice*lobstr.co', G1, '4242')
    const status = checkRecipient('alice*lobstr.co', G2, '4242')
    expect(status.status === 'changed' && status.what).toBe('address')
  })
})

describe('when storage cannot be used', () => {
  it('answers new rather than throwing when the store is unreadable', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      },
    })
    expect(checkRecipient('deon.xlm', G1)).toEqual({ status: 'new' })
    expect(() => pinRecipient('deon.xlm', G1)).not.toThrow()
  })

  it('answers new when the stored value is not a book', () => {
    store.set('intent.addressbook.v1', '"not an object"')
    expect(checkRecipient('deon.xlm', G1)).toEqual({ status: 'new' })
    store.set('intent.addressbook.v1', '{not json')
    expect(checkRecipient('deon.xlm', G1)).toEqual({ status: 'new' })
  })

  it('answers new on the server, where there is no window', () => {
    vi.stubGlobal('window', undefined)
    expect(checkRecipient('deon.xlm', G1)).toEqual({ status: 'new' })
    expect(() => pinRecipient('deon.xlm', G1)).not.toThrow()
  })
})
