import { Header } from '@/components/dashboard/header'
import { Dashboard } from '@/components/dashboard/dashboard'

export default function Page() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <Dashboard />
    </div>
  )
}
