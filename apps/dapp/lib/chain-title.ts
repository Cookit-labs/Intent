/** A chain's name as the UI shows it: just the name, unless it is a testnet, which says so. */
export function chainTitle(name: string, networkLabel: string): string {
  return /testnet/i.test(networkLabel) ? networkLabel : name
}
