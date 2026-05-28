import type { Metadata } from 'next'

export function createMetadata(options: {
  title: string
  description: string
  path?: string
}): Metadata {
  const url = `${process.env['NEXT_PUBLIC_APP_URL'] ?? ''}${options.path ?? ''}`
  return {
    title: options.title,
    description: options.description,
    openGraph: {
      title: options.title,
      description: options.description,
      url,
      type: 'website',
    },
    twitter: { card: 'summary_large_image', title: options.title, description: options.description },
    alternates: { canonical: url },
  }
}