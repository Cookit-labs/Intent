import { createLinqClient } from '../linq/client'
import type { NairaOrderRepo, NairaOrderRow } from './orders'
import { normaliseStatus } from './status'

/**
 * Asks the provider where an order stands, immediately before it is paid.
 *
 * The stored status is only the last thing this app was told, and it can be
 * wrong in either direction: a webhook that arrives with a name that says one
 * thing and a status that says another, or a webhook that never arrives. The
 * provider is the authority on whether it is still waiting for a deposit, so
 * the pay step reads it there rather than trusting a copy.
 *
 * An order this app has already paid is left alone. When the provider cannot
 * be reached the stored row is returned unchanged, so a payment is only ever
 * allowed on a status that was positively `waiting`.
 *
 * Amounts are deliberately not written back: what a waiting order expects is
 * what it was made for, and the payment is asserted against exactly that.
 */
export async function reconcileBeforePay(
  repo: NairaOrderRepo,
  row: NairaOrderRow,
  linq: Pick<ReturnType<typeof createLinqClient>, 'getStatus'> = createLinqClient()
): Promise<NairaOrderRow> {
  if (row.paymentHash !== undefined) return row

  const live = await linq.getStatus(row.providerOrder)
  if (!live.ok || live.value.status === '') return row

  const status = normaliseStatus(live.value.status)
  if (status !== row.status || live.value.status !== row.providerStatus) {
    await repo.setStatus(row.providerOrder, status, live.value.status)
  }
  return { ...row, status, providerStatus: live.value.status }
}
