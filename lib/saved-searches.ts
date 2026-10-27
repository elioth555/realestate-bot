import { AMENITY_KEYS, listingLinks, type AmenityKey, type DealType, type Listing } from './listings'
import { EMPTY_FILTERS, filterListings, type Filters, type SortKey } from './filters'

export const SORT_KEYS: readonly SortKey[] = ['newest', 'price-asc', 'price-desc', 'surface-desc']

/** Per saved search; "unseen" is the absence of a stored row. */
export const STORED_LISTING_STATES = ['viewed', 'sent', 'rejected'] as const
export type StoredListingState = (typeof STORED_LISTING_STATES)[number]
export type ListingState = 'unseen' | StoredListingState

export const LISTING_STATE_LABELS: Record<ListingState, string> = {
  unseen: 'Unseen',
  viewed: 'Viewed',
  sent: 'Sent to client',
  rejected: 'Not relevant',
}

export type SavedSearch = {
  id: string
  name: string
  scope: DealType
  filters: Filters
  sort: SortKey
  clientName: string | null
  clientPhone: string | null
  clientEmail: string | null
  notes: string | null
  lastCheckedAt: string
  createdAt: string
  updatedAt: string
}

export type SavedSearchRow = {
  id: string
  name: string
  transaction_type: string
  filters: unknown
  sort: string | null
  client_name: string | null
  client_phone: string | null
  client_email: string | null
  notes: string | null
  last_checked_at: string
  created_at: string
  updated_at: string
}

export const SAVED_SEARCH_COLUMNS =
  'id,name,transaction_type,filters,sort,client_name,client_phone,client_email,notes,last_checked_at,created_at,updated_at'

export type ListingStateEntry = { listingId: string; state: StoredListingState; updatedAt: string }

export const LIMITS = { name: 120, clientName: 120, clientPhone: 40, clientEmail: 200, notes: 2000, filterText: 100, neighborhoods: 60 }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LISTING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const isSavedSearchId = (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id)
export const isListingId = (id: unknown): id is string => typeof id === 'string' && LISTING_ID_RE.test(id)
export const isStoredListingState = (s: unknown): s is StoredListingState =>
  typeof s === 'string' && (STORED_LISTING_STATES as readonly string[]).includes(s)

function text(value: unknown, max = LIMITS.filterText): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function nullableText(value: unknown, max = LIMITS.filterText): string | null {
  return text(value, max) || null
}

/**
 * Coerces stored or submitted filters into the dashboard's own Filters shape, so a saved search is always
 * matched by the same filterListings() call as the live dashboard. Unknown amenities and fields are dropped.
 */
export function sanitizeFilters(raw: unknown): Filters {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const neighborhoods = Array.isArray(r.neighborhoods)
    ? [...new Set(r.neighborhoods.map((n) => text(n)).filter(Boolean))].slice(0, LIMITS.neighborhoods)
    : []
  const amenities = Array.isArray(r.amenities)
    ? [...new Set(r.amenities.filter((a): a is AmenityKey => (AMENITY_KEYS as readonly unknown[]).includes(a)))]
    : []
  return {
    ...EMPTY_FILTERS,
    city: nullableText(r.city),
    neighborhoods,
    minPrice: text(r.minPrice, 20),
    maxPrice: text(r.maxPrice, 20),
    minRooms: nullableText(r.minRooms, 10),
    maxRooms: nullableText(r.maxRooms, 10),
    minSurface: text(r.minSurface, 20),
    maxSurface: text(r.maxSurface, 20),
    propertyType: nullableText(r.propertyType),
    amenities,
  }
}

export const sanitizeSort = (sort: unknown): SortKey =>
  (SORT_KEYS as readonly unknown[]).includes(sort) ? (sort as SortKey) : 'newest'

export function rowToSavedSearch(row: SavedSearchRow): SavedSearch | null {
  if (row.transaction_type !== 'rent' && row.transaction_type !== 'sale') return null
  return {
    id: row.id,
    name: row.name,
    scope: row.transaction_type,
    filters: sanitizeFilters(row.filters),
    sort: sanitizeSort(row.sort),
    clientName: row.client_name,
    clientPhone: row.client_phone,
    clientEmail: row.client_email,
    notes: row.notes,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type ClientFields = Partial<Pick<SavedSearch, 'name' | 'clientName' | 'clientPhone' | 'clientEmail' | 'notes'>>

/** Validated column patch for a rename or client-details edit; returns errors instead of truncating a name. */
export function clientFieldsPatch(input: ClientFields): { ok: true; patch: Record<string, string | null> } | { ok: false; message: string } {
  const patch: Record<string, string | null> = {}
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) return { ok: false, message: 'Give the search a name.' }
    if (name.length > LIMITS.name) return { ok: false, message: `Keep the name under ${LIMITS.name} characters.` }
    patch.name = name
  }
  const optional: [keyof ClientFields, string, number][] = [
    ['clientName', 'client_name', LIMITS.clientName],
    ['clientPhone', 'client_phone', LIMITS.clientPhone],
    ['clientEmail', 'client_email', LIMITS.clientEmail],
    ['notes', 'notes', LIMITS.notes],
  ]
  for (const [key, column, max] of optional) {
    if (input[key] === undefined) continue
    const value = typeof input[key] === 'string' ? (input[key] as string).trim() : ''
    if (value.length > max) return { ok: false, message: `Keep ${column.replace('_', ' ')} under ${max} characters.` }
    patch[column] = value || null
  }
  if (patch.client_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.client_email)) {
    return { ok: false, message: 'That email address does not look valid.' }
  }
  return { ok: true, patch }
}

/** Same call as the live dashboard tab for this deal type: freshness does not affect matching. */
export function savedSearchMatches(cards: Listing[], search: Pick<SavedSearch, 'filters' | 'scope'>): Listing[] {
  return filterListings(cards, search.filters, search.scope)
}

function time(iso: string | null | undefined) {
  const t = iso ? new Date(iso).getTime() : Number.NaN
  return Number.isFinite(t) ? t : null
}

/** New = first seen strictly after the search was last checked. No known first-seen date is never new. */
export function isNewSince(card: Pick<Listing, 'firstSeenAt'>, lastCheckedAt: string): boolean {
  const seen = time(card.firstSeenAt)
  const checked = time(lastCheckedAt)
  return seen !== null && checked !== null && seen > checked
}

export function summarizeSavedSearch(cards: Listing[], search: SavedSearch) {
  const matches = savedSearchMatches(cards, search)
  return { matches: matches.length, newMatches: matches.filter((c) => isNewSince(c, search.lastCheckedAt)).length }
}

/** Dashboard state that reproduces the saved search: its filters, its Rent/Sale tab and its sort. */
export function restoreDashboardState(search: SavedSearch) {
  return {
    filters: { ...search.filters, neighborhoods: [...search.filters.neighborhoods], amenities: [...search.filters.amenities] },
    tab: search.scope,
    sort: search.sort,
  }
}

function canonical(filters: Filters) {
  const f = sanitizeFilters(filters)
  return JSON.stringify({ ...f, neighborhoods: [...f.neighborhoods].sort(), amenities: [...f.amenities].sort() })
}

export const sameFilters = (a: Filters, b: Filters) => canonical(a) === canonical(b)

/**
 * A merged card is as old as the earliest source listing behind it, so a new Facebook or Madlan duplicate of
 * an apartment already on the dashboard never counts as a new match.
 */
export function resolveCardFirstSeen(cards: Listing[], sourceListings: Listing[]): Listing[] {
  const byId = new Map<string, string>()
  const byUrl = new Map<string, string>()
  for (const l of sourceListings) {
    if (!l.firstSeenAt) continue
    byId.set(l.id, l.firstSeenAt)
    if (l.url) byUrl.set(l.url, l.firstSeenAt)
  }
  return cards.map((card) => {
    const dates = [
      card.firstSeenAt,
      ...listingLinks(card).map((link) => byId.get(link.id)),
      ...(card.alsoPostedAt ?? []).map((url) => byUrl.get(url)),
    ].filter((d): d is string => time(d) !== null)
    if (!dates.length) return card
    const earliest = dates.reduce((a, b) => ((time(b) as number) < (time(a) as number) ? b : a))
    return { ...card, firstSeenAt: earliest }
  })
}

/**
 * State is stored against a source listing id. A merged card can change representative between loads,
 * so the latest state recorded against any of its members applies.
 */
export function cardListingState(card: Listing, states: ListingStateEntry[]): ListingState {
  const ids = new Set([card.id, ...listingLinks(card).map((l) => l.id)])
  let latest: ListingStateEntry | null = null
  for (const entry of states) {
    if (!ids.has(entry.listingId)) continue
    if (!latest || (time(entry.updatedAt) ?? 0) > (time(latest.updatedAt) ?? 0)) latest = entry
  }
  return latest?.state ?? 'unseen'
}

/** Ids whose stored state must be cleared when a card goes back to "unseen". */
export function cardMemberIds(card: Listing): string[] {
  return [...new Set([card.id, ...listingLinks(card).map((l) => l.id)])].filter(isListingId)
}
