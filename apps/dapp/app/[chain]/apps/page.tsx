import { PageHeader } from '@intent/ui'

import { VenueGrid } from '../../../components/apps/venue-grid'
import { parseChainSegment } from '@intent/config'

import { availableVenueIds } from '../../../lib/venues'

export default async function AppsPage({
  params,
}: {
  params: Promise<{ chain: string }>
}): Promise<JSX.Element> {
  const route = parseChainSegment((await params).chain)
  const racing = route?.slug === 'stellar' || route?.slug === 'arc'
  // Decided here, on the server: which venues exist on this network depends
  // on configuration the browser cannot see.
  const availableIds = [...availableVenueIds()]
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Apps"
        description={
          racing
            ? 'The liquidity venues your intents can reach. Agents compete across these to fill your order — you never pick one yourself.'
            : 'The apps your intents can reach on this chain. Ask in chat, or name the one you want.'
        }
      />
      <VenueGrid availableIds={availableIds} />
    </div>
  )
}
