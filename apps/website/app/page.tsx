import { Hero } from '../components/sections/hero'
import { HowItWorks } from '../components/sections/how-it-works'
import { Ecosystem } from '../components/sections/ecosystem'
import { ForBuilders } from '../components/sections/for-builders'
import { FinalCta } from '../components/sections/final-cta'
import { Faq } from '../components/sections/faq'
import { Navbar } from '../components/layout/navbar'
import { Footer } from '../components/layout/footer'

export default function Home() {
  return (
    <>
      <Navbar />
      <main className="pt-16">
        <Hero />
        <HowItWorks />
        <Ecosystem />
        <ForBuilders />
        <Faq />
        {/* <FinalCta /> */}
      </main>
      <Footer />
    </>
  )
}
