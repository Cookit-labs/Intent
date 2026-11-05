import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  type Address,
} from '@solana/kit'
import { describe, expect, it } from 'vitest'

import {
  assertDepositAmount,
  assertWrapAtMost,
  decodeSolanaTransaction,
  ownWrappedSolAccount,
  solanaAssertSafe,
} from '../chains/solana/assert-safe'
import {
  CAPTURE_ACCOUNT,
  JUPITER_DFLOW_ROUTE,
  JUPITER_LEND_USDC_DEPOSIT,
  JUPITER_SOL_TO_USDC,
  JUPITER_USDC_TO_ONYC,
  KAMINO_USDC_DEPOSIT,
  LULO_USDC_DEPOSIT,
} from '../chains/solana/__fixtures__/captured-transactions'
import {
  JUPITER_LEND_POLICY,
  JUPITER_SWAP_POLICY,
  KAMINO_POLICY,
  LULO_POLICY,
  JUPITER_LEND_PROGRAM,
  KVAULT_PROGRAM,
} from '../chains/solana/programs'
import { ChainActionRefused } from '../chains/types'

const ATTACKER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address
const FOREIGN_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' as Address
const SYSTEM = '11111111111111111111111111111111' as Address
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111' as Address
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address

type Message = {
  version: number | 'legacy'
  header: {
    numSignerAccounts: number
    numReadonlySignerAccounts: number
    numReadonlyNonSignerAccounts: number
  }
  staticAccounts: readonly Address[]
  lifetimeToken: string
  instructions: readonly {
    programAddressIndex: number
    accountIndices?: readonly number[]
    data?: Uint8Array
  }[]
  addressTableLookups?: readonly unknown[]
}

function open(base64: string): Message {
  const { messageBytes } = getTransactionDecoder().decode(Buffer.from(base64, 'base64'))
  return getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as Message
}

/** Re-serialises a changed message in front of a single empty signature slot, or several. */
function close(message: Message, signatureCount = message.header.numSignerAccounts): string {
  const bytes = getCompiledTransactionMessageEncoder().encode(
    message as unknown as Parameters<
      ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']
    >[0]
  )
  return Buffer.concat([
    Buffer.from([signatureCount]),
    Buffer.alloc(64 * signatureCount),
    Buffer.from(bytes),
  ]).toString('base64')
}

/**
 * Appends a read-only account to the static list. Lookup table indices sit after
 * the static accounts, so they shift up by one to keep pointing at the same thing.
 */
function withStatic(message: Message, address: Address): { message: Message; index: number } {
  const oldCount = message.staticAccounts.length
  return {
    index: oldCount,
    message: {
      ...message,
      header: {
        ...message.header,
        numReadonlyNonSignerAccounts: message.header.numReadonlyNonSignerAccounts + 1,
      },
      staticAccounts: [...message.staticAccounts, address],
      instructions: message.instructions.map((ix) => ({
        ...ix,
        programAddressIndex:
          ix.programAddressIndex >= oldCount ? ix.programAddressIndex + 1 : ix.programAddressIndex,
        accountIndices: (ix.accountIndices ?? []).map((i) => (i >= oldCount ? i + 1 : i)),
      })),
    },
  }
}

/** Adds an instruction for `program`, with the accounts it names added to the static list. */
function withInstruction(
  message: Message,
  program: Address,
  accounts: readonly Address[],
  data: number[]
): string {
  let next = message
  const indexOf = (address: Address): number => {
    const found = next.staticAccounts.indexOf(address)
    if (found !== -1) return found
    const added = withStatic(next, address)
    next = added.message
    return added.index
  }
  const programAddressIndex = indexOf(program)
  const accountIndices = accounts.map(indexOf)
  next = {
    ...next,
    instructions: [
      ...next.instructions,
      { programAddressIndex, accountIndices, data: new Uint8Array(data) },
    ],
  }
  return close(next)
}

function u64(value: bigint): number[] {
  const out: number[] = []
  let rest = value
  for (let i = 0; i < 8; i += 1) {
    out.push(Number(rest & BigInt(255)))
    rest >>= BigInt(8)
  }
  return out
}

const systemTransfer = (lamports: bigint): number[] => [2, 0, 0, 0, ...u64(lamports)]

const swapSafe = solanaAssertSafe(JUPITER_SWAP_POLICY)
const lendSafe = solanaAssertSafe(JUPITER_LEND_POLICY)
const kaminoSafe = solanaAssertSafe(KAMINO_POLICY)
const luloSafe = solanaAssertSafe(LULO_POLICY)
const solana = (transaction: string) => ({ family: 'solana' as const, transaction })

describe('real captured transactions pass', () => {
  it.each([
    ['jupiter swap with SOL wrapping', swapSafe, JUPITER_SOL_TO_USDC],
    ['jupiter swap creating a token account', swapSafe, JUPITER_USDC_TO_ONYC],
    ['jupiter lend deposit', lendSafe, JUPITER_LEND_USDC_DEPOSIT],
    ['kamino deposit', kaminoSafe, KAMINO_USDC_DEPOSIT],
    ['lulo deposit', luloSafe, LULO_USDC_DEPOSIT],
  ])('%s', (_name, safe, transaction) => {
    expect(() => safe(solana(transaction), CAPTURE_ACCOUNT)).not.toThrow()
  })

  it('still passes once re-encoded unchanged, which proves the tamper helper is honest', () => {
    const again = close(open(JUPITER_SOL_TO_USDC))
    expect(again).toBe(JUPITER_SOL_TO_USDC)
    expect(() => swapSafe(solana(again), CAPTURE_ACCOUNT)).not.toThrow()
  })
})

describe('fee payer and signers', () => {
  it('refuses when the account checked is not the fee payer', () => {
    expect(() => swapSafe(solana(JUPITER_SOL_TO_USDC), ATTACKER)).toThrow(ChainActionRefused)
    expect(() => swapSafe(solana(JUPITER_SOL_TO_USDC), ATTACKER)).toThrow(/fee/i)
  })

  it('refuses a transaction whose fee payer was swapped', () => {
    const message = open(JUPITER_SOL_TO_USDC)
    const tampered = close({
      ...message,
      staticAccounts: [ATTACKER, ...message.staticAccounts.slice(1)],
    })
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/fee/i)
  })

  it('refuses a second required signer', () => {
    const message = open(JUPITER_LEND_USDC_DEPOSIT)
    const tampered = close({ ...message, header: { ...message.header, numSignerAccounts: 2 } }, 2)
    expect(() => lendSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/sign/i)
  })

  it('refuses a read-only fee payer', () => {
    const message = open(JUPITER_LEND_USDC_DEPOSIT)
    const tampered = close({
      ...message,
      header: { ...message.header, numReadonlySignerAccounts: 1 },
    })
    expect(() => lendSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })

  it('refuses an account that is not a Solana address', () => {
    expect(() =>
      swapSafe(solana(JUPITER_SOL_TO_USDC), '0x0000000000000000000000000000000000000000')
    ).toThrow(ChainActionRefused)
  })
})

describe('programs', () => {
  it('refuses a foreign program added to a real transaction', () => {
    const tampered = withInstruction(open(JUPITER_SOL_TO_USDC), FOREIGN_PROGRAM, [], [1, 2, 3])
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/program/i)
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })

  it('does not take one venue’s program for another’s', () => {
    expect(() => swapSafe(solana(KAMINO_USDC_DEPOSIT), CAPTURE_ACCOUNT)).toThrow(/program/i)
    expect(() => kaminoSafe(solana(JUPITER_LEND_USDC_DEPOSIT), CAPTURE_ACCOUNT)).toThrow(/program/i)
    expect(() => lendSafe(solana(JUPITER_USDC_TO_ONYC), CAPTURE_ACCOUNT)).toThrow(/program/i)
  })

  it('refuses a router the swap venue excludes', () => {
    expect(() => swapSafe(solana(JUPITER_DFLOW_ROUTE), CAPTURE_ACCOUNT)).toThrow(/program/i)
  })

  it('refuses a program index that points into a lookup table', () => {
    const message = open(JUPITER_SOL_TO_USDC)
    const beyondStatic = message.staticAccounts.length + 1
    const tampered = close({
      ...message,
      instructions: [
        ...message.instructions,
        { programAddressIndex: beyondStatic, accountIndices: [], data: new Uint8Array([1]) },
      ],
    })
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/lookup|program/i)
  })

  it('refuses a venue instruction outside the kinds this deposit needs', () => {
    const message = open(KAMINO_USDC_DEPOSIT)
    const instructions = message.instructions.map((ix) => {
      if (message.staticAccounts[ix.programAddressIndex] !== KVAULT_PROGRAM) return ix
      const data = Uint8Array.from(ix.data ?? [])
      data[0] = (data[0] as number) ^ 0xff
      return { ...ix, data }
    })
    expect(() => kaminoSafe(solana(close({ ...message, instructions })), CAPTURE_ACCOUNT)).toThrow(
      /instruction/i
    )
  })
})

describe('system program', () => {
  const ownWsol = (): Address => ownWrappedSolAccount(CAPTURE_ACCOUNT) as Address

  it('refuses an added transfer to anyone else', () => {
    const tampered = withInstruction(
      open(JUPITER_SOL_TO_USDC),
      SYSTEM,
      [CAPTURE_ACCOUNT as Address, ATTACKER],
      systemTransfer(BigInt(1_000_000_000))
    )
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/transfer/i)
  })

  it('refuses a transfer on a venue that has no reason to wrap SOL', () => {
    const tampered = withInstruction(
      open(JUPITER_LEND_USDC_DEPOSIT),
      SYSTEM,
      [CAPTURE_ACCOUNT as Address, ownWsol()],
      systemTransfer(BigInt(1))
    )
    expect(() => lendSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })

  it('refuses a transfer whose destination hides in a lookup table', () => {
    const message = open(JUPITER_SOL_TO_USDC)
    const systemIndex = message.staticAccounts.indexOf(SYSTEM)
    const tampered = close({
      ...message,
      instructions: [
        ...message.instructions,
        {
          programAddressIndex: systemIndex,
          accountIndices: [0, message.staticAccounts.length + 2],
          data: new Uint8Array(systemTransfer(BigInt(1))),
        },
      ],
    })
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })

  it.each([
    [
      'create account',
      [0, 0, 0, 0, ...u64(BigInt(1)), ...u64(BigInt(0)), ...new Array(32).fill(0)],
    ],
    ['assign', [1, 0, 0, 0, ...new Array(32).fill(0)]],
    ['advance nonce', [4, 0, 0, 0]],
    ['withdraw nonce', [5, 0, 0, 0, ...u64(BigInt(1))]],
    ['transfer with seed', [11, 0, 0, 0, ...u64(BigInt(1))]],
  ])('refuses %s', (_name, data) => {
    const tampered = withInstruction(
      open(JUPITER_SOL_TO_USDC),
      SYSTEM,
      [CAPTURE_ACCOUNT as Address, ATTACKER],
      data
    )
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })
})

describe('token program', () => {
  const account = CAPTURE_ACCOUNT as Address
  const wsol = (): Address => ownWrappedSolAccount(CAPTURE_ACCOUNT) as Address

  it.each([
    ['transfer', [3, ...u64(BigInt(1))]],
    ['approve', [4, ...u64(BigInt(1))]],
    ['set authority', [6, 2, 0]],
    ['transfer checked', [12, ...u64(BigInt(1)), 6]],
    ['burn', [8, ...u64(BigInt(1))]],
  ])('refuses a top-level %s', (_name, data) => {
    const tampered = withInstruction(
      open(JUPITER_SOL_TO_USDC),
      TOKEN,
      [wsol(), ATTACKER, account],
      data
    )
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })

  it('refuses closing the wrapped account into someone else', () => {
    const tampered = withInstruction(
      open(JUPITER_SOL_TO_USDC),
      TOKEN,
      [wsol(), ATTACKER, account],
      [9]
    )
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/close/i)
  })

  it('refuses closing some other token account', () => {
    const tampered = withInstruction(
      open(JUPITER_SOL_TO_USDC),
      TOKEN,
      [ATTACKER, account, account],
      [9]
    )
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/close/i)
  })

  it('refuses syncing some other account', () => {
    const tampered = withInstruction(open(JUPITER_SOL_TO_USDC), TOKEN, [ATTACKER], [17])
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })
})

describe('associated token program', () => {
  const account = CAPTURE_ACCOUNT as Address

  it('refuses a token account created for someone else', () => {
    const tampered = withInstruction(
      open(JUPITER_USDC_TO_ONYC),
      ATA,
      [account, ATTACKER, ATTACKER, ATTACKER, SYSTEM, TOKEN],
      [1]
    )
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/token account/i)
  })

  it('refuses a token account paid for by someone else', () => {
    const tampered = withInstruction(
      open(JUPITER_USDC_TO_ONYC),
      ATA,
      [ATTACKER, ATTACKER, account, ATTACKER, SYSTEM, TOKEN],
      [1]
    )
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/token account/i)
  })

  it('refuses recovering a nested token account', () => {
    const tampered = withInstruction(
      open(JUPITER_USDC_TO_ONYC),
      ATA,
      [account, ATTACKER, account, ATTACKER, SYSTEM, TOKEN],
      [2]
    )
    expect(() => swapSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })
})

describe('compute budget', () => {
  const setPrice = (microLamports: bigint): number[] => [3, ...u64(microLamports)]

  it('refuses a priority fee that would drain the fee payer', () => {
    const tampered = withInstruction(
      open(JUPITER_LEND_USDC_DEPOSIT),
      COMPUTE_BUDGET,
      [],
      setPrice(BigInt(10_000_000_000))
    )
    expect(() => lendSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(/priority fee/i)
  })

  it('allows the priority fees the live APIs set', () => {
    const tampered = withInstruction(
      open(JUPITER_LEND_USDC_DEPOSIT),
      COMPUTE_BUDGET,
      [],
      setPrice(BigInt(300_000))
    )
    expect(() => lendSafe(solana(tampered), CAPTURE_ACCOUNT)).not.toThrow()
  })

  it('refuses an unknown compute budget instruction', () => {
    const tampered = withInstruction(open(JUPITER_LEND_USDC_DEPOSIT), COMPUTE_BUDGET, [], [9, 0])
    expect(() => lendSafe(solana(tampered), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })
})

describe('malformed payloads', () => {
  it('refuses garbage', () => {
    expect(() => swapSafe(solana('not base64 at all !!'), CAPTURE_ACCOUNT)).toThrow(
      ChainActionRefused
    )
    expect(() => swapSafe(solana('AAAA'), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })

  it('refuses trailing bytes smuggled after the message', () => {
    const padded = Buffer.concat([
      Buffer.from(JUPITER_LEND_USDC_DEPOSIT, 'base64'),
      Buffer.from([1, 2, 3]),
    ]).toString('base64')
    expect(() => lendSafe(solana(padded), CAPTURE_ACCOUNT)).toThrow(ChainActionRefused)
  })

  it('refuses another chain’s payload', () => {
    expect(() =>
      swapSafe({ family: 'sui', transaction: JUPITER_SOL_TO_USDC }, CAPTURE_ACCOUNT)
    ).toThrow(ChainActionRefused)
  })
})

describe('ownWrappedSolAccount', () => {
  it('derives the account the live API used, synchronously', () => {
    expect(ownWrappedSolAccount(CAPTURE_ACCOUNT)).toBe(
      'CDpxuy4Liae8HPUKA788gLi3QRgnH17PEEip2zem8hHw'
    )
  })
})

describe('decodeSolanaTransaction', () => {
  it('reads the fee payer and leaves the signature slot empty on an unsigned transaction', () => {
    const decoded = decodeSolanaTransaction(JUPITER_LEND_USDC_DEPOSIT)
    expect(decoded.feePayer).toBe(CAPTURE_ACCOUNT)
    expect(decoded.feePayerSignature).toBeNull()
  })
})

describe('assertDepositAmount', () => {
  it('accepts the amount the capture was built for', () => {
    expect(() =>
      assertDepositAmount(JUPITER_LEND_USDC_DEPOSIT, JUPITER_LEND_PROGRAM, '1000000')
    ).not.toThrow()
    expect(() => assertDepositAmount(KAMINO_USDC_DEPOSIT, KVAULT_PROGRAM, '1000000')).not.toThrow()
  })

  it('refuses a deposit of a different amount from the one asked for', () => {
    expect(() => assertDepositAmount(KAMINO_USDC_DEPOSIT, KVAULT_PROGRAM, '999999')).toThrow(
      /amount/i
    )
  })

  it('refuses a transaction with no deposit in it', () => {
    expect(() =>
      assertDepositAmount(JUPITER_USDC_TO_ONYC, JUPITER_LEND_PROGRAM, '1000000')
    ).toThrow(ChainActionRefused)
  })
})

describe('assertWrapAtMost', () => {
  it('allows wrapping what the swap spends', () => {
    expect(() => assertWrapAtMost(JUPITER_SOL_TO_USDC, BigInt(10_000_000))).not.toThrow()
  })

  it('refuses wrapping more than the swap spends', () => {
    expect(() => assertWrapAtMost(JUPITER_SOL_TO_USDC, BigInt(9_999_999))).toThrow(
      ChainActionRefused
    )
  })

  it('counts nothing on a transaction that does not wrap', () => {
    expect(() => assertWrapAtMost(JUPITER_USDC_TO_ONYC, BigInt(0))).not.toThrow()
  })
})
