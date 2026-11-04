import { Suspense } from 'react'

import { ConnectHome } from '../components/connect/connect-home'

/** The app's front door: connect a wallet, and the chain it is on goes into the address. */
export default function HomePage(): JSX.Element {
  return (
    <Suspense fallback={<div className="app-canvas h-screen" />}>
      <ConnectHome />
    </Suspense>
  )
}
