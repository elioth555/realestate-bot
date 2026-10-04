import { Header } from '@/components/dashboard/header'
import { Dashboard } from '@/components/dashboard/dashboard'
import { parseDashboardParams, type RawSearchParams } from '@/lib/dashboard-url'

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const initialState = parseDashboardParams(await searchParams)

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <Dashboard initialState={initialState} />
    </div>
  )
}
