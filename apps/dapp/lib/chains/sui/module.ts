import { canIssueOneClick, oneClickOriginVenue } from '../oneclick-origin'
import type { ChainModule, ChainVenue } from '../types'
import { cetusVenue } from './cetus'
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
  ]
}

export const suiModule: ChainModule = {
  chain: 'sui',
  tokens: SUI_TOKENS,
  venues: buildSuiVenues(),
  defaultVenue: { swap: 'cetus', supply: 'navi', stake: 'springsui' },
  priceUsd: (token) => priceFromLlama(token),
  submit: (input) => submitSui(input),
}
