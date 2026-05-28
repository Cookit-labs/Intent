// TODO: implement encoding/signing utilities
export const formatUSDC = (amount: string, decimals = 6): string => {
  return (BigInt(amount) / BigInt(10 ** decimals)).toString()
}

export const parseUSDC = (amount: string, decimals = 6): string => {
  return (BigInt(Math.floor(parseFloat(amount) * 10 ** decimals))).toString()
}

export const shortenAddress = (address: string, chars = 4): string => {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}