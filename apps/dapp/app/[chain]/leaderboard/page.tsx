import { redirect } from 'next/navigation'

export default function Page({ params }: { params: { chain: string } }): never {
  redirect(`/${params.chain}/agents`)
}
