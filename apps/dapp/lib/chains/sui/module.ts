import { canIssueOneClick, oneClickOriginVenue } from '../oneclick-origin'
import { createSendVenue, SEND_VENUE_ID } from '../send'
import type { ChainModule, ChainVenue } from '../types'
import { aftermathVenue } from './aftermath'
import { readSuiBalances } from './balances'
import { cetusVenue } from './cetus'
import { deepbookVenue } from './deepbook'
import { momentumVenue } from './momentum'
import { naviVenue } from './navi'
import { priceFromLlama } from './price'
import { scallopVenue } from './scallop'
import { springsuiVenue } from './springsui'
import { submitSui } from './submit'
import { suilendVenue } from './suilend'
import { SUI_TOKENS } from './tokens'
import { walrusVenue } from './walrus'

export function buildSuiVenues(
  env: Record<string, string | undefined> = process.env
): ChainVenue[] {
  return [
    cetusVenue,
    deepbookVenue,
    momentumVenue,
    ...(canIssueOneClick(env) ? [oneClickOriginVenue('sui')] : []),
    naviVenue,
    suilendVenue,
    scallopVenue,
    springsuiVenue,
    aftermathVenue,
    walrusVenue,
    ...(canIssueOneClick(env) ? [createSendVenue('sui')] : []),
  ]
}

export const suiModule: ChainModule = {
  chain: 'sui',
  tokens: SUI_TOKENS,
  venues: buildSuiVenues(),
  defaultVenue: {
    swap: 'cetus',
    supply: 'navi',
    withdraw: 'navi',
    borrow: 'navi',
    repay: 'navi',
    stake: 'springsui',
    unstake: 'springsui',
    send: SEND_VENUE_ID,
  },
  venueForToken: {
    stake: { WAL: 'walrus' },
    unstake: { WAL: 'walrus', SSUI: 'springsui', AFSUI: 'aftermath' },
  },
  priceUsd: (token) => priceFromLlama(token),
  submit: (input) => submitSui(input),
  balances: readSuiBalances,
}
