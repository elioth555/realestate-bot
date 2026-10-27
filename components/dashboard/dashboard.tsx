'use client'

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { buildCityIndex, collectPropertyTypes, type Listing } from '@/lib/listings'
import { SupabaseLoadError, fetchListings } from '@/lib/supabase'
import {
  EMPTY_FILTERS,
  countActiveFilters,
  describeFilters,
  filterListings,
  sortListings,
  type DealScope,
  type Filters,
  type SortKey,
} from '@/lib/filters'
import {
  restoreDashboardState,
  sameFilters,
  summarizeSavedSearch,
  type SavedSearch,
} from '@/lib/saved-searches'
import { ActiveSavedSearchBar } from './active-saved-search-bar'
import type { SaveSearchInput } from './save-search-form'
import { ActiveSavedSearchContext, useListingStates, useSavedSearches, type ActiveSavedSearch } from './use-saved-searches'
import {
  serializeDashboardParams,
  type DashboardUrlState,
  type TabKey,
} from '@/lib/dashboard-url'
import { FilterPanel } from './filter-panel'
import { ListingsGrid } from './listings-grid'
import { ListingsError, ListingsLoading } from './listings-status'
import { SavedSearches } from './saved-searches'
import { StatsBar } from './stats-bar'
import { buildSourceInputs } from '@/lib/refresh-all'
import { RefreshAllStatus } from './refresh-all-status'
import { useMadlanSearch } from './use-madlan-search'
import { FACEBOOK_REFRESH_INPUT, useFacebookSearch } from './use-facebook-search'
import { useRefreshAll } from './use-refresh-all'
import { useYad2Search } from './use-yad2-search'

const QUIET = { quiet: true }

const SORT_OPTIONS: { label: string; value: SortKey }[] = [
  { label: 'Newest first', value: 'newest' },
  { label: 'Price: low to high', value: 'price-asc' },
  { label: 'Price: high to low', value: 'price-desc' },
  { label: 'Largest surface', value: 'surface-desc' },
]

const NO_LISTINGS: Listing[] = []

export function Dashboard({ initialState }: { initialState: DashboardUrlState }) {
  const { data, error, isLoading, mutate } = useSWR('supabase:properties', fetchListings, {
    revalidateOnFocus: false,
  })
  const listings = data ?? NO_LISTINGS
  const cities = useMemo(() => buildCityIndex(listings), [listings])
  const propertyTypes = useMemo(() => collectPropertyTypes(listings), [listings])

  const [tab, setTab] = useState<TabKey>(initialState.tab)
  const [draft, setDraft] = useState<Filters>(initialState.filters)
  // Local filtering follows the panel live; deferring keeps typing responsive while 500+ listings re-filter.
  const applied = useDeferredValue(draft)
  const [sort, setSort] = useState<SortKey>(initialState.sort)
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set())
  const [filtersOpen, setFiltersOpen] = useState(false)
  const saved = useSavedSearches()
  const [openSearchId, setOpenSearchId] = useState<string | null>(null)

  const scope: DealScope = tab === 'rent' || tab === 'sale' ? tab : 'all'

  // A saved search stays "open" only while the dashboard still shows exactly its criteria.
  const openSearch = saved.searches.find((s) => s.id === openSearchId) ?? null
  const activeSearch = openSearch && tab === openSearch.scope && sameFilters(draft, openSearch.filters) ? openSearch : null
  const listingStates = useListingStates(activeSearch?.id ?? null)
  const activeContext = useMemo<ActiveSavedSearch | null>(
    () =>
      activeSearch
        ? { search: activeSearch, stateOf: listingStates.stateOf, setState: (card, state) => void listingStates.setState(card, state) }
        : null,
    [activeSearch, listingStates],
  )

  const { yad2: yad2Input, madlan: madlanInput } = buildSourceInputs(draft, scope)
  // Each source keeps its own runs, polling and Supabase refetch; the combined status replaces their toasts.
  const yad2 = useYad2Search(yad2Input, () => mutate(), data, QUIET)
  const madlan = useMadlanSearch(madlanInput, () => mutate(), data, QUIET)
  const facebook = useFacebookSearch(() => mutate(), data, QUIET)
  const refresh = useRefreshAll(
    { yad2, madlan, facebook },
    { yad2: yad2Input, madlan: madlanInput, facebook: FACEBOOK_REFRESH_INPUT },
  )

  useEffect(() => {
    console.info('[dashboard] restored filters from URL', {
      tab: initialState.tab,
      sort: initialState.sort,
      activeFilters: countActiveFilters(initialState.filters),
      filters: initialState.filters,
    })
  }, [initialState])

  useEffect(() => {
    const query = serializeDashboardParams({ filters: applied, tab, sort })
    if (query === window.location.search.replace(/^\?/, '')) return
    window.history.replaceState(window.history.state, '', query ? `?${query}` : window.location.pathname)
  }, [applied, tab, sort])

  const results = useMemo(() => {
    const base = tab === 'favorites' ? listings.filter((l) => favorites.has(l.id)) : listings
    return sortListings(filterListings(base, applied, scope), sort)
  }, [listings, tab, favorites, applied, scope, sort])

  const counts = useMemo(
    () => ({
      all: filterListings(listings, applied, 'all').length,
      rent: filterListings(listings, applied, 'rent').length,
      sale: filterListings(listings, applied, 'sale').length,
    }),
    [listings, applied],
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
    if (tab === 'saved') setTab('all')
    setFiltersOpen(false)
  }

  const handleRefreshAll = () => {
    if (tab === 'saved') setTab('all')
    void refresh.refreshAll()
  }

  const describedParts = describeFilters(draft, scope)
  const suggestedSaveName = describedParts.length ? describedParts.slice(0, 3).join(' · ') : 'All listings'

  const handleSave = async ({ name, scope: saveScope }: SaveSearchInput) => {
    const created = await saved.create({ name, scope: saveScope, filters: draft, sort })
    if (!created) return false
    setFiltersOpen(false)
    toast.success('Search saved', { description: created.name })
    return true
  }

  const handleReset = () => {
    setDraft(EMPTY_FILTERS)
  }

  const openSavedSearch = (search: SavedSearch) => {
    const restored = restoreDashboardState(search)
    setDraft(restored.filters)
    setTab(restored.tab)
    setSort(restored.sort)
    setOpenSearchId(search.id)
    // Opening counts as checking: the "new" badge resets to listings first seen after now.
    void saved.markChecked(search.id)
  }

  const deleteSavedSearch = async (id: string) => {
    const deleted = await saved.remove(id)
    if (deleted) {
      if (openSearchId === id) setOpenSearchId(null)
      toast('Saved search deleted')
    }
    return deleted
  }

  const panel = (
    <FilterPanel
      filters={draft}
      cities={cities}
      propertyTypes={propertyTypes}
      onChange={setDraft} onSearch={handleSearch} onSave={handleSave}
      saveScope={scope === 'sale' ? 'sale' : 'rent'}
      suggestedSaveName={suggestedSaveName}
      onReset={handleReset}
      onRefreshAll={handleRefreshAll}
      refreshing={refresh.isRefreshing}
      priceStep={scope === 'sale' ? 50_000 : 500} />
  )

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'all', label: 'All listings', count: counts.all },
    { key: 'rent', label: 'Rent', count: counts.rent },
    { key: 'sale', label: 'Sale', count: counts.sale },
    { key: 'saved', label: 'Saved searches', count: saved.searches.length },
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

      <StatsBar listings={listings} />

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
            <RefreshAllStatus summary={refresh.summary} newListings={refresh.newListings} onDismiss={refresh.dismiss} />
            {error ? (
              <ListingsError
                message={error instanceof SupabaseLoadError ? error.message : 'Could not reach Supabase.'}
                hint={
                  error instanceof SupabaseLoadError
                    ? error.hint
                    : 'Check your connection and that the Supabase project is online.'
                }
                onRetry={() => mutate()}
              />
            ) : isLoading ? (
              <ListingsLoading />
            ) : tab === 'saved' ? (
              saved.loadError ? (
                <ListingsError
                  message={saved.loadError.message}
                  hint="Saved searches are stored in Supabase. Check that the saved_searches table exists."
                  onRetry={() => saved.retry()}
                />
              ) : saved.isLoading ? (
                <ListingsLoading />
              ) : (
                <SavedSearches
                  searches={saved.searches}
                  summaryOf={(s) => summarizeSavedSearch(listings, s)}
                  onOpen={openSavedSearch}
                  onUpdate={saved.update}
                  onDelete={deleteSavedSearch}
                />
              )
            ) : (
              <ActiveSavedSearchContext.Provider value={activeContext}>
                {activeContext && (
                  <ActiveSavedSearchBar active={activeContext} results={results} onClose={() => setOpenSearchId(null)} />
                )}
                <p className="mb-4 text-sm text-muted-foreground" aria-live="polite">
                  <span className="font-medium text-foreground tabular-nums">{results.length}</span>
                  {` ${results.length === 1 ? 'listing' : 'listings'} found`}
                  {activeFilterCount > 0 && ` · ${activeFilterCount} active ${activeFilterCount === 1 ? 'filter' : 'filters'}`}
                </p>
                <ListingsGrid
                  listings={results}
                  favorites={favorites}
                  onToggleFavorite={toggleFavorite}
                  emptyTitle={tab === 'favorites' ? 'No favorites match' : 'No listings found'}
                  emptyDescription={
                    tab === 'favorites'
                      ? 'Tap the heart on any listing to add it to your favorites.'
                      : 'Try widening your price range or removing some amenities.'
                  }
                />
              </ActiveSavedSearchContext.Provider>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
