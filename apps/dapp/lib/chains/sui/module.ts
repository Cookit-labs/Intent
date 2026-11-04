import { oneClickOriginVenue } from '../oneclick-origin'
import type { ChainModule } from '../types'
import { cetusVenue } from './cetus'
import { naviVenue } from './navi'
import { priceFromLlama } from './price'
import { springsuiVenue } from './springsui'
import { submitSui } from './submit'
import { SUI_TOKENS } from './tokens'

export const suiModule: ChainModule = {
  chain: 'sui',
  tokens: SUI_TOKENS,
  venues: [cetusVenue, oneClickOriginVenue('sui'), naviVenue, springsuiVenue],
  defaultVenue: { swap: 'cetus', supply: 'navi', stake: 'springsui' },
  priceUsd: (token) => priceFromLlama(token),
  submit: (input) => submitSui(input),
}
