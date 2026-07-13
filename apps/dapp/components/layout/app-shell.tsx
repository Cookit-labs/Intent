'use client'

import { type ReactNode } from 'react'

import { Header } from './header'
import { Sidebar } from './sidebar'

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="bg-surface-base flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
