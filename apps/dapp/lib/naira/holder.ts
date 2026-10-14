import { getNairaOrderRepo } from './orders'

/**
 * The holder of an account this user has been paid out to, from their own
 * earlier order, or nothing.
 *
 * Never throws: a database that cannot be reached means "not on record", and
 * the caller asks the provider as it did before.
 */
export async function holderOnRecord(
  email: string,
  bankCode: string,
  accountNumber: string
): Promise<string | undefined> {
  try {
    const repo = await getNairaOrderRepo()
    return await repo.findHolder(email, bankCode, accountNumber)
  } catch {
    return undefined
  }
}
