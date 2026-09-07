import { Badge, PageHeader } from '@intent/ui'

import { BalanceCard } from '../../../components/vault/balance-card'
import { EscrowCard } from '../../../components/vault/escrow-card'

export default function VaultPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Vault"
        description="Wallet balances are live. Escrow flows arrive with the settlement contracts."
        badge={<Badge variant="outline">Balances live · escrow soon</Badge>}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <BalanceCard />
        <EscrowCard />
      </div>
    </div>
  )
}
