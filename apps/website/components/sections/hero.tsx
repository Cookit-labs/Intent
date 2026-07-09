import Image from 'next/image'
import { ArrowUpRight } from 'lucide-react'

const THUMBNAILS = [
  '/images/Image1.webp',
  '/images/image2.webp',
  '/images/image3.webp',
  '/images/image4.jpg',
]

export function Hero() {
  return (
    <section id="hero" className="relative overflow-hidden px-6 py-32">
      {/* <div className="pointer-events-none absolute left-1/4 top-1 hidden h-[200px] w-[200px] rotate-[20deg] -translate-x-1/2 overflow-hidden lg:block">
        <Image src="/images/Arc.png" alt="" fill sizes="160px" className="object-contain p-4" />
      </div>
      <div className="pointer-events-none absolute right-1/4 top-1/3 hidden h-[200px] w-[200px] rotate-[-20deg] translate-x-1/2 overflow-hidden lg:block">
        <Image src="/images/desktop.jpg" alt="" fill sizes="160px" className="object-contain p-4" />
      </div> */}

      <div className="mx-auto max-w-3xl text-center">
        <h1 className="font-display mt-4 text-5xl leading-tight md:text-6xl">
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

        <a
          href="#"
          className="bg-foreground text-background mt-8 inline-block rounded-full px-6 py-3 text-sm font-medium transition-opacity hover:opacity-90"
        >
          Book a Demo
        </a>
      </div>

      <div className="relative mx-auto mt-20 hidden max-w-5xl overflow-hidden md:block">
        <div className="from-background pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r to-transparent" />
        <div className="from-background pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l to-transparent" />
        <div className="animate-marquee flex w-max">
          {[...THUMBNAILS, ...THUMBNAILS, ...THUMBNAILS].map((src, i) => (
            <div
              key={i}
              className="relative mr-4 aspect-[2/3] w-48 shrink-0 overflow-hidden rounded-lg"
            >
              <Image src={src} alt="" fill sizes="192px" className="object-cover" />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
