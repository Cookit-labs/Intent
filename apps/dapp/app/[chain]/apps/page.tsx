import { PageHeader } from '@intent/ui'

import { VenueGrid } from '../../../components/apps/venue-grid'
import { availableVenueIds } from '../../../lib/venues'

export default function AppsPage(): JSX.Element {
  // Decided here, on the server: which venues exist on this network depends
  // on configuration the browser cannot see.
  const availableIds = [...availableVenueIds()]
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Apps"
        description="The liquidity venues your intents can reach. Agents compete across these to fill your order — you never pick one yourself."
      />
      <VenueGrid availableIds={availableIds} />
    </div>
  )
}
