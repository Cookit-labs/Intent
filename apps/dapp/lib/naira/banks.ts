// Nigerian banks the payout provider supports, from its published list.
// Codes are the provider's; the payout is refused for any other.
export interface NigerianBank {
  code: string
  name: string
  /** A local copy of the bank's mark, from nigerianbanks.xyz. Absent when it has none. */
  logo?: string
}

export const NIGERIAN_BANKS: readonly NigerianBank[] = [
  {
    code: '044',
    name: 'Access Bank',
    logo: '/bank-logos/044.png',
  },
  {
    code: '023',
    name: 'Citibank',
    logo: '/bank-logos/023.png',
  },
  {
    code: '063',
    name: 'Diamond Bank',
    logo: '/bank-logos/063.png',
  },
  {
    code: '050',
    name: 'Ecobank Bank',
    logo: '/bank-logos/050.png',
  },
  {
    code: '060002',
    name: 'FBNQuest Merchant Bank',
  },
  {
    code: '214',
    name: 'FCMB',
    logo: '/bank-logos/214.png',
  },
  {
    code: '070',
    name: 'Fidelity Bank',
    logo: '/bank-logos/070.png',
  },
  {
    code: '011',
    name: 'First Bank Of Nigeria',
    logo: '/bank-logos/011.png',
  },
  {
    code: '501',
    name: 'FSDH Merchant Bank',
    logo: '/bank-logos/501.png',
  },
  {
    code: '060004',
    name: 'Greenwich Merchant Bank',
    logo: '/bank-logos/060004.png',
  },
  {
    code: '058',
    name: 'Guaranty Trust Bank',
    logo: '/bank-logos/058.png',
  },
  {
    code: '030',
    name: 'Heritage',
  },
  {
    code: '301',
    name: 'Jaiz Bank',
    logo: '/bank-logos/301.png',
  },
  {
    code: '082',
    name: 'Keystone Bank',
    logo: '/bank-logos/082.png',
  },
  {
    code: '090267',
    name: 'Kuda Microfinance Bank',
    logo: '/bank-logos/090267.png',
  },
  {
    code: '090405',
    name: 'Moniepoint MFB',
    logo: '/bank-logos/090405.png',
  },
  {
    code: '100004',
    name: 'OPay',
    logo: '/bank-logos/100004.png',
  },
  {
    code: '100033',
    name: 'PalmPay',
    logo: '/bank-logos/100033.png',
  },
  {
    code: '100039',
    name: 'Paystack-Titan MFB',
    logo: '/bank-logos/100039.png',
  },
  {
    code: '076',
    name: 'Polaris Bank',
    logo: '/bank-logos/076.png',
  },
  {
    code: '101',
    name: 'Providus Bank',
    logo: '/bank-logos/101.png',
  },
  {
    code: '502',
    name: 'Rand Merchant Bank',
    logo: '/bank-logos/502.png',
  },
  {
    code: '090286',
    name: 'Safe Haven MFB',
    logo: '/bank-logos/090286.png',
  },
  {
    code: '039',
    name: 'Stanbic IBTC Bank',
    logo: '/bank-logos/039.png',
  },
  {
    code: '068',
    name: 'Standard Chartered Bank',
    logo: '/bank-logos/068.png',
  },
  {
    code: '232',
    name: 'Sterling Bank',
    logo: '/bank-logos/232.png',
  },
  {
    code: '100',
    name: 'Suntrust Bank',
    logo: '/bank-logos/100.png',
  },
  {
    code: '032',
    name: 'Union Bank',
    logo: '/bank-logos/032.png',
  },
  {
    code: '033',
    name: 'United Bank for Africa',
    logo: '/bank-logos/033.png',
  },
  {
    code: '215',
    name: 'Unity Bank',
    logo: '/bank-logos/215.png',
  },
  {
    code: '035',
    name: 'Wema Bank',
    logo: '/bank-logos/035.png',
  },
  {
    code: '057',
    name: 'Zenith Bank',
    logo: '/bank-logos/057.png',
  },
]

export function bankByCode(code: string): NigerianBank | undefined {
  return NIGERIAN_BANKS.find((b) => b.code === code)
}
