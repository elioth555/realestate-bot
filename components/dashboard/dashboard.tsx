'use client'

import { useMemo, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LISTINGS } from '@/lib/listings'
import {
  EMPTY_FILTERS,
  countActiveFilters,
  describeFilters,
  filterListings,
  sortListings,
  type DealScope,
  type Filters,
  type SavedSearch,
  type SortKey,
} from '@/lib/filters'
import { FilterPanel } from './filter-panel'
import { ListingsGrid } from './listings-grid'
import { SavedSearches } from './saved-searches'
import { StatsBar } from './stats-bar'

type TabKey = 'all' | 'rent' | 'sale' | 'saved' | 'favorites'

const SORT_OPTIONS: { label: string; value: SortKey }[] = [
  { label: 'Newest first', value: 'newest' },
  { label: 'Price: low to high', value: 'price-asc' },
  { label: 'Price: high to low', value: 'price-desc' },
  { label: 'Largest surface', value: 'surface-desc' },
]

const INITIAL_SAVED: SavedSearch[] = [
  {
    id: 's-1',
    name: 'Tel Aviv 3+ rooms with Mamad',
    scope: 'rent',
    filters: { ...EMPTY_FILTERS, city: 'Tel Aviv', minRooms: '3', maxPrice: '10000', amenities: ['mamad'] },
    createdAt: 'Sep 24, 2026',
  },
  {
    id: 's-2',
    name: 'Sea view properties for sale',
    scope: 'sale',
    filters: { ...EMPTY_FILTERS, amenities: ['seaView'] },
    createdAt: 'Sep 18, 2026',
  },
]

export function Dashboard() {
  const [tab, setTab] = useState<TabKey>('all')
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)
  const [sort, setSort] = useState<SortKey>('newest')
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(['l-1002', 'l-1005']))
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(INITIAL_SAVED)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const scope: DealScope = tab === 'rent' || tab === 'sale' ? tab : 'all'

  const results = useMemo(() => {
    const base = tab === 'favorites' ? LISTINGS.filter((l) => favorites.has(l.id)) : LISTINGS
    return sortListings(filterListings(base, applied, scope), sort)
  }, [tab, favorites, applied, scope, sort])

  const counts = useMemo(
    () => ({
      all: filterListings(LISTINGS, applied, 'all').length,
      rent: filterListings(LISTINGS, applied, 'rent').length,
      sale: filterListings(LISTINGS, applied, 'sale').length,
    }),
    [applied],
  )

  const activeFilterCount = countActiveFilters(applied)

  const toggleFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSearch = () => {
    setApplied(draft)
    if (tab === 'saved') setTab('all')
    setFiltersOpen(false)
  }

  const handleSave = () => {
    const parts = describeFilters(draft, scope)
    const name = parts.length ? parts.slice(0, 3).join(' · ') : 'All listings'
    const search: SavedSearch = {
      id: `s-${Date.now()}`,
      name,
      scope,
      filters: draft,
      createdAt: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date()),
    }
    setSavedSearches((prev) => [search, ...prev])
    setApplied(draft)
    setFiltersOpen(false)
    toast.success('Search saved', { description: name })
  }

  const handleReset = () => {
    setDraft(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
  }

  const runSavedSearch = (search: SavedSearch) => {
    setDraft(search.filters)
    setApplied(search.filters)
    setTab(search.scope)
  }

  const deleteSavedSearch = (id: string) => {
    setSavedSearches((prev) => prev.filter((s) => s.id !== id))
    toast('Saved search deleted')
  }

  const panel = (
    <FilterPanel filters={draft} onChange={setDraft} onSearch={handleSearch} onSave={handleSave} onReset={handleReset} />
  )

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'all', label: 'All listings', count: counts.all },
    { key: 'rent', label: 'Rent', count: counts.rent },
    { key: 'sale', label: 'Sale', count: counts.sale },
    { key: 'saved', label: 'Saved searches', count: savedSearches.length },
    { key: 'favorites', label: 'Favorites', count: favorites.size },
  ]

  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6">
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Listings dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Rental and sale listings aggregated from Facebook, Yad2 and Madlan in one place.
        </p>
      </div>

      <StatsBar listings={LISTINGS} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="hidden lg:block" aria-label="Search filters">
          <div className="sticky top-22 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-xl border bg-card">
            <div className="p-5">{panel}</div>
          </div>
        </aside>

        <section className="min-w-0" aria-label="Listings">
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
            <div className="flex flex-col gap-3 border-b pb-3 md:flex-row md:items-center md:justify-between">
              <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
                <TabsList className="h-9 bg-muted">
                  {tabs.map((t) => (
                    <TabsTrigger key={t.key} value={t.key} className="gap-1.5 px-3">
                      {t.label}
                      <span className="rounded-full bg-background/80 px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums in-data-active:bg-primary in-data-active:text-primary-foreground">
                        {t.count}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>

              {tab !== 'saved' && (
                <div className="flex items-center gap-2">
                  <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
                    <SheetTrigger render={<Button variant="outline" className="h-9 gap-1.5 lg:hidden" />}>
                      <SlidersHorizontal className="size-4" aria-hidden="true" />
                      Filters
                      {activeFilterCount > 0 && (
                        <span className="rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground tabular-nums">
                          {activeFilterCount}
                        </span>
                      )}
                    </SheetTrigger>
                    <SheetContent side="left" className="w-full overflow-y-auto sm:max-w-sm">
                      <SheetHeader className="sr-only">
                        <SheetTitle>Search filters</SheetTitle>
                      </SheetHeader>
                      <div className="p-5">{panel}</div>
                    </SheetContent>
                  </Sheet>

                  <Select items={SORT_OPTIONS} value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                    <SelectTrigger aria-label="Sort listings" className="h-9 min-w-44 bg-card">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      {SORT_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </Tabs>

          <div className="mt-4">
            {tab === 'saved' ? (
              <SavedSearches
                searches={savedSearches}
                matchCount={(s) => filterListings(LISTINGS, s.filters, s.scope).length}
                onRun={runSavedSearch}
                onDelete={deleteSavedSearch}
              />
            ) : (
              <>
                <p className="mb-4 text-sm text-muted-foreground" aria-live="polite">
                  <span className="font-medium text-foreground tabular-nums">{results.length}</span>
                  {` ${results.length === 1 ? 'listing' : 'listings'} found`}
                  {activeFilterCount > 0 && ` · ${activeFilterCount} active ${activeFilterCount === 1 ? 'filter' : 'filters'}`}
                </p>
                <ListingsGrid
                  listings={results}
                  favorites={favorites}
                  onToggleFavorite={toggleFavorite}
                  emptyTitle={tab === 'favorites' ? 'No favorites match' : 'No listings match your filters'}
                  emptyDescription={
                    tab === 'favorites'
                      ? 'Tap the heart on any listing to add it to your favorites.'
                      : 'Try widening your price range or removing some amenities.'
                  }
                />
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
