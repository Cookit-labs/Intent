import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { AdminShell } from '../../components/admin/admin-shell'

export const metadata: Metadata = {
  title: 'Intent Admin',
  robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: { children: ReactNode }): JSX.Element {
  return <AdminShell>{children}</AdminShell>
}
