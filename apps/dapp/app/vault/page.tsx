import { Badge, PageHeader } from '@intent/ui'

import { EscrowCard } from '../../components/vault/escrow-card'

export default function VaultPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Intent Terminal"
        title="Vault"
        description="Escrow balances and USDC flows for your intents. Coming soon."
        badge={<Badge variant="outline">Preview · Coming soon</Badge>}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <EscrowCard />
        <EscrowCard />
      </div>
    </div>
  )
}
