import { redirect } from 'next/navigation'

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ chain: string }>
}): Promise<never> {
  redirect(`/${(await params).chain}/intents`)
}
