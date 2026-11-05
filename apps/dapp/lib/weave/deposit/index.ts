import type { CashoutChain, DepositChain } from '../types'
import { avalancheDeposit } from './avalanche'
import { nearDeposit } from './near'
import { solanaDeposit } from './solana'
import { stellarDeposit } from './stellar'
import { suiDeposit } from './sui'

const DEPOSITS: Record<CashoutChain, DepositChain> = {
  stellar: stellarDeposit,
  solana: solanaDeposit,
  avalanche: avalancheDeposit,
  sui: suiDeposit,
  near: nearDeposit,
}

export function depositChain(chain: CashoutChain): DepositChain {
  return DEPOSITS[chain]
}
