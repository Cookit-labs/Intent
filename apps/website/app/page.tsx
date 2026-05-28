import { Hero } from '../components/sections/hero'
import { ProtocolViz } from '../components/sections/protocol-viz'
import { Marketplace } from '../components/sections/marketplace'
import { Agents } from '../components/sections/agents'
import { Reputation } from '../components/sections/reputation'
import { Architecture } from '../components/sections/architecture'
import { Security } from '../components/sections/security'
import { LeaderboardPreview } from '../components/sections/leaderboard-preview'
import { Ecosystem } from '../components/sections/ecosystem'
import { Roadmap } from '../components/sections/roadmap'
import { FAQ } from '../components/sections/faq'
import { Navbar } from '../components/layout/navbar'
import { Footer } from '../components/layout/footer'

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <ProtocolViz />
        <Marketplace />
        <Agents />
        <Reputation />
        <Architecture />
        <Security />
        <LeaderboardPreview />
        <Ecosystem />
        <Roadmap />
        <FAQ />
      </main>
      <Footer />
    </>
  )
}