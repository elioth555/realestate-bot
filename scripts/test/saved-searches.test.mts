/**
 * Saved searches: filter round-trip, matching parity with the dashboard, new-match counting, per-client state. Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/saved-searches.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMENITY_KEYS, type AmenityKey, type Listing, type Source, type TriState } from '../../lib/listings.ts'
import { EMPTY_FILTERS, filterListings, type Filters } from '../../lib/filters.ts'
import { dedupeAcrossSources } from '../../lib/cross-source-dedupe.ts'
import {
  cardListingState,
  cardMemberIds,
  clientFieldsPatch,
  isNewSince,
  resolveCardFirstSeen,
  restoreDashboardState,
  rowToSavedSearch,
  sameFilters,
  sanitizeFilters,
  summarizeSavedSearch,
  type SavedSearch,
  type SavedSearchRow,
} from '../../lib/saved-searches.ts'

function features(overrides: Partial<Record<AmenityKey, TriState>> = {}): Record<AmenityKey, TriState> {
  const all = Object.fromEntries(AMENITY_KEYS.map((k) => [k, 'unknown'])) as Record<AmenityKey, TriState>
  return { ...all, ...overrides }
}

let seq = 0
function listing(source: Source, overrides: Partial<Listing> = {}): Listing {
  const f = overrides.features ?? features()
  seq++
  return {
    id: `${source}-${seq}`,
    title: 'Apartment',
    description: '',
    dealType: 'rent',
    price: 9_000,
    city: 'Tel Aviv',
    neighborhood: 'Old North',
    street: `דיזנגוף ${100 + seq}`,
    rooms: 3,
    surface: 75,
    floor: 2,
    propertyType: 'Apartment',
    amenities: AMENITY_KEYS.filter((k) => f[k] === 'yes'),
    features: f,
    protectedSpaceType: null,
    entryDate: null,
    known: { price: true, rooms: true, surface: true },
    phone: '',
    source,
    url: `https://example.com/${source}/${seq}`,
    publishedAt: null,
    publishedMinutesAgo: 60,
    firstSeenAt: '2026-10-01T10:00:00.000Z',
    photos: [],
    image: null,
    ...overrides,
  }
}

function search(filters: Partial<Filters>, extra: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Marc - Old North 3 rooms',
    scope: 'rent',
    filters: { ...EMPTY_FILTERS, ...filters },
    sort: 'newest',
    clientName: null,
    clientPhone: null,
    clientEmail: null,
    notes: null,
    lastCheckedAt: '2026-10-10T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  }
}

/** Simulates the jsonb round-trip through Supabase. */
function roundTrip(s: SavedSearch): SavedSearch {
  const row: SavedSearchRow = {
    id: s.id,
    name: s.name,
    transaction_type: s.scope,
    filters: JSON.parse(JSON.stringify(s.filters)),
    sort: s.sort,
    client_name: s.clientName,
    client_phone: s.clientPhone,
    client_email: s.clientEmail,
    notes: s.notes,
    last_checked_at: s.lastCheckedAt,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  }
  const out = rowToSavedSearch(row)
  assert.ok(out)
  return out
}

const cards = [
  listing('yad2', { neighborhood: 'Old North', rooms: 3, price: 9_000, features: features({ mamad: 'yes' }) }),
  listing('madlan', { neighborhood: 'Lev HaIr', rooms: 3.5, price: 11_000, features: features({ mamad: 'yes' }) }),
  listing('facebook', { neighborhood: 'Florentin', rooms: 2.5, price: 7_000 }),
  listing('yad2', { dealType: 'sale', neighborhood: 'Old North', rooms: 4, price: 4_200_000, surface: 110 }),
  listing('madlan', { dealType: 'sale', neighborhood: 'Neve Tzedek', rooms: 5, price: 8_000_000, surface: 160 }),
]

test('save Rent search: stored filters match exactly what the dashboard shows', () => {
  const filters = { ...EMPTY_FILTERS, city: 'Tel Aviv', minRooms: '3' }
  const saved = roundTrip(search(filters))
  assert.equal(saved.scope, 'rent')
  assert.deepEqual(
    summarizeSavedSearch(cards, saved).matches,
    filterListings(cards, filters, 'rent').length,
  )
})

test('save Sale search uses the sale scope', () => {
  const saved = roundTrip(search({ city: 'Tel Aviv' }, { scope: 'sale', sort: 'price-desc' }))
  assert.equal(saved.scope, 'sale')
  assert.equal(saved.sort, 'price-desc')
  assert.equal(summarizeSavedSearch(cards, saved).matches, filterListings(cards, saved.filters, 'sale').length)
  assert.ok(filterListings(cards, saved.filters, 'sale').every((c) => c.dealType === 'sale'))
})

test('multiple neighborhoods, half rooms, price range and amenities survive the round-trip', () => {
  const filters: Filters = {
    ...EMPTY_FILTERS,
    city: 'Tel Aviv',
    neighborhoods: ['Old North', 'Lev HaIr'],
    minRooms: '3',
    maxRooms: '3.5',
    minPrice: '8000',
    maxPrice: '12000',
    amenities: ['mamad'],
  }
  const saved = roundTrip(search(filters))
  assert.ok(sameFilters(saved.filters, filters))
  assert.equal(saved.filters.maxRooms, '3.5')
  const live = filterListings(cards, filters, 'rent').map((c) => c.id)
  assert.deepEqual(filterListings(cards, saved.filters, 'rent').map((c) => c.id), live)
})

test('sanitizeFilters drops unknown amenities and fields', () => {
  const f = sanitizeFilters({ amenities: ['mamad', 'jacuzzi'], hack: 1, neighborhoods: ['A', 'A', ''] })
  assert.deepEqual(f.amenities, ['mamad'])
  assert.deepEqual(f.neighborhoods, ['A'])
  assert.equal((f as Record<string, unknown>).hack, undefined)
})

test('reopen restores filters, tab and sort exactly', () => {
  const s = roundTrip(search({ city: 'Tel Aviv', neighborhoods: ['Old North'], minRooms: '2.5' }, { scope: 'sale', sort: 'surface-desc' }))
  const restored = restoreDashboardState(s)
  assert.equal(restored.tab, 'sale')
  assert.equal(restored.sort, 'surface-desc')
  assert.ok(sameFilters(restored.filters, s.filters))
  restored.filters.neighborhoods.push('mutated')
  assert.deepEqual(s.filters.neighborhoods, ['Old North'], 'restore copies arrays')
})

test('new-match count: only matches first seen after last_checked_at; checking resets it', () => {
  const pool = [
    listing('yad2', { firstSeenAt: '2026-10-05T00:00:00.000Z' }),
    listing('yad2', { firstSeenAt: '2026-10-12T00:00:00.000Z' }),
    listing('madlan', { firstSeenAt: '2026-10-15T00:00:00.000Z' }),
    listing('madlan', { firstSeenAt: '2026-10-15T00:00:00.000Z', rooms: 1 }),
    listing('facebook', { firstSeenAt: null }),
  ]
  const s = search({ minRooms: '3' })
  assert.deepEqual(summarizeSavedSearch(pool, s), { matches: 4, newMatches: 2 })
  const checked = { ...s, lastCheckedAt: '2026-10-20T00:00:00.000Z' }
  assert.equal(summarizeSavedSearch(pool, checked).newMatches, 0)
  assert.equal(isNewSince({ firstSeenAt: 'garbage' }, s.lastCheckedAt), false)
})

test('rename and client fields are validated', () => {
  assert.deepEqual(clientFieldsPatch({ name: '  Dana - Sale  ' }), { ok: true, patch: { name: 'Dana - Sale' } })
  assert.equal(clientFieldsPatch({ name: '   ' }).ok, false)
  assert.equal(clientFieldsPatch({ name: 'x'.repeat(121) }).ok, false)
  assert.equal(clientFieldsPatch({ clientEmail: 'not-an-email' }).ok, false)
  assert.deepEqual(clientFieldsPatch({ clientPhone: '' }), { ok: true, patch: { client_phone: null } })
})

test('delete: an invalid stored row is skipped rather than crashing the list', () => {
  const row = { ...JSON.parse('{}'), transaction_type: 'lease' } as SavedSearchRow
  assert.equal(rowToSavedSearch(row), null)
})

test('cross-source merged listing counts once and is not new when an old member exists', () => {
  const y2 = listing('yad2', { street: 'דיזנגוף 50', firstSeenAt: '2026-10-01T00:00:00.000Z' })
  const md = listing('madlan', { street: 'דיזנגוף 50', firstSeenAt: '2026-10-15T00:00:00.000Z', photos: ['a', 'b', 'c'] })
  const merged = resolveCardFirstSeen(dedupeAcrossSources([y2, md]), [y2, md])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].firstSeenAt, '2026-10-01T00:00:00.000Z')
  assert.deepEqual(summarizeSavedSearch(merged, search({ city: 'Tel Aviv' })), { matches: 1, newMatches: 0 })
})

test('per-search state follows the merged card whichever member it was stored on', () => {
  const y2 = listing('yad2', { street: 'דיזנגוף 60' })
  const md = listing('madlan', { street: 'דיזנגוף 60', photos: ['a', 'b'] })
  const [card] = dedupeAcrossSources([y2, md])
  assert.deepEqual(cardMemberIds(card).sort(), [y2.id, md.id].sort())
  assert.equal(cardListingState(card, []), 'unseen')
  const states = [
    { listingId: y2.id, state: 'viewed' as const, updatedAt: '2026-10-10T00:00:00.000Z' },
    { listingId: md.id, state: 'sent' as const, updatedAt: '2026-10-11T00:00:00.000Z' },
  ]
  assert.equal(cardListingState(card, states), 'sent')
  assert.equal(cardListingState(listing('facebook'), states), 'unseen')
})
