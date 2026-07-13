import { PageHeader } from '@intent/ui'

import { VenueGrid } from '../../components/apps/venue-grid'

export default function AppsPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Apps"
        description="The liquidity venues your intents can reach. Agents compete across these to fill your order — you never pick one yourself."
      />
      <VenueGrid />
    </div>
  )
}
