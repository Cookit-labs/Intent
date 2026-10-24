import { redirect } from 'next/navigation'

export default async function Page({
  params,
}: {
  params: Promise<{ chain: string }>
}): Promise<never> {
  redirect(`/${(await params).chain}/intents`)
}
