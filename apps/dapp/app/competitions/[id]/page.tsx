import { Badge, PageHeader } from '@intent/ui'

import { BidStream } from '../../../components/competitions/bid-stream'
import { ProposalTable } from '../../../components/competitions/proposal-table'
import { WinnerAnnouncement } from '../../../components/competitions/winner-announcement'

export default function CompetitionDetailPage(): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow="Competition"
        title="Competition detail"
        description="Proposals, live bids, and the winning margin. Building in Slice 2."
        badge={<Badge variant="outline">Preview · Slice 2</Badge>}
      />
      <WinnerAnnouncement />
      <div className="grid gap-4 lg:grid-cols-2">
        <ProposalTable />
        <BidStream />
      </div>
    </div>
  )
}
