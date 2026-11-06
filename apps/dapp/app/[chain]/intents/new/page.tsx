import { parseChainSegment } from '@intent/config'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

export const metadata: Metadata = { title: 'New intent' }

/** The chat is drawn by `ChatHost` in the chain layout, under this page's own heading. */
export default async function NewIntentPage({
  params,
}: {
  params: Promise<{ chain: string }>
}): Promise<null> {
  if (parseChainSegment((await params).chain) === undefined) notFound()
  return null
}
