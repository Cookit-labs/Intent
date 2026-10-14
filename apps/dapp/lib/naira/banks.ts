// Nigerian banks the payout provider supports, from its published list.
// Codes are the provider's; the payout is refused for any other.
export interface NigerianBank {
  code: string
  name: string
}

export const NIGERIAN_BANKS: readonly NigerianBank[] = [
  {
    code: '044',
    name: 'Access Bank',
  },
  {
    code: '023',
    name: 'Citibank',
  },
  {
    code: '063',
    name: 'Diamond Bank',
  },
  {
    code: '050',
    name: 'Ecobank Bank',
  },
  {
    code: '060002',
    name: 'FBNQuest Merchant Bank',
  },
  {
    code: '214',
    name: 'FCMB',
  },
  {
    code: '070',
    name: 'Fidelity Bank',
  },
  {
    code: '011',
    name: 'First Bank Of Nigeria',
  },
  {
    code: '501',
    name: 'FSDH Merchant Bank',
  },
  {
    code: '060004',
    name: 'Greenwich Merchant Bank',
  },
  {
    code: '058',
    name: 'Guaranty Trust Bank',
  },
  {
    code: '030',
    name: 'Heritage',
  },
  {
    code: '301',
    name: 'Jaiz Bank',
  },
  {
    code: '082',
    name: 'Keystone Bank',
  },
  {
    code: '090267',
    name: 'Kuda Microfinance Bank',
  },
  {
    code: '090405',
    name: 'Moniepoint MFB',
  },
  {
    code: '100004',
    name: 'OPay',
  },
  {
    code: '100033',
    name: 'PalmPay',
  },
  {
    code: '100039',
    name: 'Paystack-Titan MFB',
  },
  {
    code: '076',
    name: 'Polaris Bank',
  },
  {
    code: '101',
    name: 'Providus Bank',
  },
  {
    code: '502',
    name: 'Rand Merchant Bank',
  },
  {
    code: '090286',
    name: 'Safe Haven MFB',
  },
  {
    code: '039',
    name: 'Stanbic IBTC Bank',
  },
  {
    code: '068',
    name: 'Standard Chartered Bank',
  },
  {
    code: '232',
    name: 'Sterling Bank',
  },
  {
    code: '100',
    name: 'Suntrust Bank',
  },
  {
    code: '032',
    name: 'Union Bank',
  },
  {
    code: '033',
    name: 'United Bank for Africa',
  },
  {
    code: '215',
    name: 'Unity Bank',
  },
  {
    code: '035',
    name: 'Wema Bank',
  },
  {
    code: '057',
    name: 'Zenith Bank',
  },
]

export function bankByCode(code: string): NigerianBank | undefined {
  return NIGERIAN_BANKS.find((b) => b.code === code)
}
