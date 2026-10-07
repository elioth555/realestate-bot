import type { Listing } from '@/lib/listings'
import { formatPrice } from '@/lib/filters'

function average(values: number[]) {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0
}

export function StatsBar({ listings }: { listings: Listing[] }) {
  const rentals = listings.filter((l) => l.dealType === 'rent')
  const sales = listings.filter((l) => l.dealType === 'sale')
  const newToday = listings.filter((l) => l.publishedMinutesAgo < 1440).length
  const knownPrices = (items: Listing[]) => items.filter((l) => l.known.price).map((l) => l.price)

  const stats = [
    { label: 'Active listings', value: listings.length.toString(), hint: 'Across 3 sources' },
    { label: 'New in 24h', value: newToday.toString(), hint: 'Since yesterday' },
    { label: 'Avg. rent', value: formatPrice(average(knownPrices(rentals))), hint: `${rentals.length} rentals` },
    { label: 'Avg. sale price', value: formatPrice(average(knownPrices(sales))), hint: `${sales.length} for sale` },
  ]

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border lg:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="bg-card px-4 py-3.5">
          <dt className="text-xs text-muted-foreground">{s.label}</dt>
          <dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums">{s.value}</dd>
          <dd className="text-xs text-muted-foreground">{s.hint}</dd>
        </div>
      ))}
    </dl>
  )
}
