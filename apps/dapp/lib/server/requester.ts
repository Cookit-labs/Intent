import { isWalletAddress } from '../wallet/address'
import { WALLET_HEADER } from '../wallet-header'
import { readSessionFromRequest } from './session'

/**
 * Who a request is for, where the app keeps a person's records.
 *
 * The signed-in email when there is one. With the email gate paused nobody
 * signs in, so the connected wallet stands in as `wallet:<address>`. The header is the
 * page's own claim and proves nothing about who holds the wallet: it keeps
 * one wallet's records apart from another's for honest use, and money still
 * moves only by a signature from the wallet itself.
 */
export function requesterOf(request: Request): { email: string } | undefined {
  const session = readSessionFromRequest(request)
  if (session !== undefined) return { email: session.email }
  const wallet = request.headers.get(WALLET_HEADER)?.trim()
  if (wallet !== undefined && isWalletAddress(wallet)) {
    return { email: `wallet:${wallet}` }
  }
  return undefined
}
