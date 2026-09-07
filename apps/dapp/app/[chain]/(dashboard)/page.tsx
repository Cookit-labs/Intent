import { redirect } from 'next/navigation'

export default function DashboardPage({ params }: { params: { chain: string } }): never {
  redirect(`/${params.chain}/intents`)
}
