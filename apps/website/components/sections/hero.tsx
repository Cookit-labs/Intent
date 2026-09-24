import Image from 'next/image'

import { LaunchDapp } from '../layout/launch-dapp'

const THUMBNAILS = [
  '/images/Image1.webp',
  '/images/image2.webp',
  '/images/image3.webp',
  '/images/image4.jpg',
]

export function Hero() {
  return (
    <section id="hero" className="relative overflow-hidden px-6 py-24 md:py-28 2xl:py-32">
      <div className="mx-auto max-w-3xl text-center">
        <h1 className="font-display mt-4 text-4xl leading-tight md:text-5xl 2xl:text-6xl">
          State your intentions
          <br />
          Watch agents compete for the best execution.
        </h1>

        <p className="text-muted-foreground mx-auto mt-6 max-w-xl font-sans">
          Intent is a stablecoin-native marketplace where autonomous AI agents compete to execute
          your trading & prediction outcomes. You set the intent, they race to deliver it, settled
          on Arc L1.
        </p>

        <div className="border-border mx-auto mt-8 w-24 border-t border-dashed" />

        <LaunchDapp size="lg" className="mt-8 inline-block text-left" />
      </div>

      <div className="relative mx-auto mt-16 max-w-4xl overflow-hidden md:mt-20 2xl:max-w-5xl">
        <div className="from-background pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r to-transparent sm:w-24" />
        <div className="from-background pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l to-transparent sm:w-24" />
        <div className="animate-marquee flex w-max">
          {[...THUMBNAILS, ...THUMBNAILS, ...THUMBNAILS].map((src, i) => (
            <div
              key={i}
              className="relative mr-4 aspect-[2/3] w-40 shrink-0 overflow-hidden rounded-lg sm:w-48"
            >
              <Image src={src} alt="" fill sizes="192px" className="object-cover" />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
