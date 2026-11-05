import { canIssueOneClick, oneClickOriginVenue } from '../oneclick-origin'
import { createSendVenue, SEND_VENUE_ID } from '../send'
import type { ChainModule, ChainVenue } from '../types'
import { readSuiBalances } from './balances'
import { cetusVenue } from './cetus'
import { deepbookBook, deepbookVenue } from './deepbook'
import { naviVenue } from './navi'
import { priceFromLlama } from './price'
import { springsuiVenue } from './springsui'
import { submitSui } from './submit'
import { SUI_TOKENS } from './tokens'

export function buildSuiVenues(
  env: Record<string, string | undefined> = process.env
): ChainVenue[] {
  return [
    cetusVenue,
    ...(canIssueOneClick(env) ? [oneClickOriginVenue('sui')] : []),
    naviVenue,
    springsuiVenue,
    deepbookVenue,
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
    stake: 'springsui',
    send: SEND_VENUE_ID,
    limit: 'deepbook-limit',
  },
  priceUsd: (token) => priceFromLlama(token),
  submit: (input) => submitSui(input),
  balances: readSuiBalances,
  limitBook: deepbookBook(),
}
