import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from '@solana/kit'

import {
  ASSOCIATED_TOKEN_PROGRAM,
  decodeSolanaTransaction,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from '../chains/solana/assert-safe'
import {
  accountRoles,
  computeBudget,
  STAKE_PROGRAM,
  type SolanaRpc,
} from '../chains/solana/stake-pool'
import type { PreparedAction, SigningPayload } from '../chains/types'

/** Test inputs only. Nothing here signs or sends, and the transport never touches a network. */

export const ME = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
export const SOMEONE_ELSE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
export const UNKNOWN_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
export const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'

const { readonly, signer, writable } = accountRoles

export function compileUnsigned(feePayer: string, instructions: readonly Instruction[]): string {
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(feePayer as Address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: BigInt(1) },
        m
      ),
    (m) => appendTransactionMessageInstructions(instructions, m)
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

export function payload(feePayer: string, instructions: readonly Instruction[]): SigningPayload {
  return { family: 'solana', transaction: compileUnsigned(feePayer, instructions) }
}

export const budget = computeBudget(200_000)

export function transferOf(from: string, to: string, lamports: bigint): Instruction {
  const bytes = new Uint8Array(12)
  bytes[0] = 2
  for (let i = 0; i < 8; i += 1) bytes[4 + i] = Number((lamports >> BigInt(8 * i)) & BigInt(255))
  return {
    programAddress: SYSTEM_PROGRAM as Address,
    accounts: [signer(from), writable(to)],
    data: bytes,
  }
}

/** The Token Program's `approve` with the largest amount there is. */
export function unlimitedApproval(
  tokenAccount: string,
  delegate: string,
  owner: string
): Instruction {
  return {
    programAddress: TOKEN_PROGRAM as Address,
    accounts: [writable(tokenAccount), readonly(delegate), signer(owner)],
    data: Uint8Array.from([4, 255, 255, 255, 255, 255, 255, 255, 255]),
  }
}

/** The same instruction with extra bytes after what the program reads. */
export function withExtraData(instruction: Instruction): Instruction {
  return { ...instruction, data: Uint8Array.from([...(instruction.data ?? []), 0]) }
}

/** The same instruction with a different discriminator or tag. */
export function withOtherFunction(instruction: Instruction): Instruction {
  const data = Uint8Array.from(instruction.data ?? [])
  data[0] = (data[0] ?? 0) ^ 255
  return { ...instruction, data }
}

export function withAccount(
  instruction: Instruction,
  position: number,
  address: string
): Instruction {
  const accounts = [...(instruction.accounts ?? [])]
  accounts[position] = writable(address)
  return { ...instruction, accounts }
}

export function instructionsOf(prepared: PreparedAction): Instruction[] {
  if (prepared.signing.family !== 'solana') throw new Error('Expected a Solana payload.')
  const decoded = decodeSolanaTransaction(prepared.signing.transaction)
  return decoded.instructions.map((instruction) => ({
    programAddress: decoded.staticAccounts[instruction.programIndex] as Address,
    accounts: instruction.accounts.map((index) => ({
      address: decoded.staticAccounts[index] as Address,
      role: accountRoles.readonly('11111111111111111111111111111111').role,
    })),
    data: instruction.data,
  }))
}

const NEVER_WRITABLE = new Set([
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  STAKE_PROGRAM,
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarStakeHistory1111111111111111111111111',
])

/** The instructions as built, with roles restored so that they compile back to one signer. */
export function rebuilt(prepared: PreparedAction, account: string): Instruction[] {
  const instructions = instructionsOf(prepared)
  const programs = new Set<string>(instructions.map((i) => i.programAddress))
  return instructions.map((instruction) => ({
    ...instruction,
    accounts: (instruction.accounts ?? []).map((meta) => {
      if (meta.address === account) return signer(account)
      return programs.has(meta.address) || NEVER_WRITABLE.has(meta.address)
        ? readonly(meta.address)
        : writable(meta.address)
    }),
  }))
}

export function addressBytes(address: string): number[] {
  return [...getAddressEncoder().encode(address as Address)]
}

export function u64Bytes(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & BigInt(255)))
}

export function u32Bytes(value: number): number[] {
  return Array.from({ length: 4 }, (_, i) => (value >>> (8 * i)) & 255)
}

export interface FakeAccount {
  owner: string
  lamports: bigint
  data: Uint8Array
}

/** A transport that answers from a table, and refuses anything that could send. */
export function fakeRpc(options: {
  accounts: Record<string, FakeAccount>
  epoch: number
  rent?: number
}): SolanaRpc & { calls: string[] } {
  const calls: string[] = []
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push(method)
    switch (method) {
      case 'getAccountInfo': {
        const account = options.accounts[params[0] as string]
        return {
          value:
            account === undefined
              ? null
              : {
                  owner: account.owner,
                  lamports: Number(account.lamports),
                  data: [Buffer.from(account.data).toString('base64'), 'base64'],
                },
        }
      }
      case 'getEpochInfo':
        return { epoch: options.epoch }
      case 'getLatestBlockhash':
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } }
      case 'getMinimumBalanceForRentExemption':
        return options.rent ?? 1_666_240
      case 'getStakeMinimumDelegation':
        return { value: 1_000_000_000 }
      default:
        throw new Error(`This test must not call ${method}.`)
    }
  }
  return Object.assign(rpc, { calls })
}

export interface PoolFixture {
  poolMint: string
  reserveStake: string
  managerFeeAccount: string
  validatorList: string
  totalLamports: bigint
  poolTokenSupply: bigint
  lastUpdateEpoch: bigint
  solWithdrawalFee?: [bigint, bigint]
  stakeWithdrawalFee?: [bigint, bigint]
  solDepositAuthority?: string
  solWithdrawAuthority?: string
}

const NO_FEE = [BigInt(0), BigInt(0)] as const

function fee([numerator, denominator]: readonly [bigint, bigint]): number[] {
  return [...u64Bytes(denominator), ...u64Bytes(numerator)]
}

function option(address: string | undefined): number[] {
  return address === undefined ? [0] : [1, ...addressBytes(address)]
}

/** A stake pool in the program's own Borsh layout, field by field. */
export function encodeStakePool(fixture: PoolFixture): Uint8Array {
  const zero = addressBytes(SYSTEM_PROGRAM)
  return Uint8Array.from([
    1,
    ...zero,
    ...zero,
    ...zero,
    255,
    ...addressBytes(fixture.validatorList),
    ...addressBytes(fixture.reserveStake),
    ...addressBytes(fixture.poolMint),
    ...addressBytes(fixture.managerFeeAccount),
    ...addressBytes(TOKEN_PROGRAM),
    ...u64Bytes(fixture.totalLamports),
    ...u64Bytes(fixture.poolTokenSupply),
    ...u64Bytes(fixture.lastUpdateEpoch),
    ...u64Bytes(BigInt(0)),
    ...u64Bytes(BigInt(0)),
    ...zero,
    ...fee([BigInt(4), BigInt(100)]),
    0,
    0,
    0,
    ...fee(NO_FEE),
    ...fee(fixture.stakeWithdrawalFee ?? NO_FEE),
    0,
    0,
    ...option(fixture.solDepositAuthority),
    ...fee(NO_FEE),
    0,
    ...option(fixture.solWithdrawAuthority),
    ...fee(fixture.solWithdrawalFee ?? NO_FEE),
    0,
    ...u64Bytes(BigInt(0)),
    ...u64Bytes(BigInt(0)),
  ])
}
