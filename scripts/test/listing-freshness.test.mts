/**
 * Read-time freshness status on dashboard listings and merged cards. Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/listing-freshness.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMENITY_KEYS, type AmenityKey, type Listing, type Source, type TriState } from '../../lib/listings.ts'
import type { CoverageRun } from '../../lib/freshness.ts'
import { freshnessInput, resolveCardFreshness, withFreshness } from '../../lib/listing-freshness.ts'
import { dedupeAcrossSources } from '../../lib/cross-source-dedupe.ts'
import { filterListings, EMPTY_FILTERS } from '../../lib/filters.ts'

const features = Object.fromEntries(AMENITY_KEYS.map((k) => [k, 'unknown'])) as Record<AmenityKey, TriState>
let seq = 0
function listing(source: Source, overrides: Partial<Listing> = {}): Listing {
  seq++
  return {
    id: `${source}-${seq}`,
    title: 'Apartment',
    description: '',
    dealType: 'rent',
    price: 9_000,
    city: 'Tel Aviv',
    neighborhood: 'Neve Tzedek',
    street: 'שבזי 10',
    rooms: 3,
    surface: 75,
    floor: 2,
    propertyType: 'Apartment',
    amenities: [],
    features,
    protectedSpaceType: null,
    entryDate: null,
    known: { price: true, rooms: true, surface: true },
    phone: '',
    source,
    url: `https://example.com/${source}/${seq}`,
    publishedAt: null,
    publishedMinutesAgo: 0,
    photos: [],
    image: null,
    ...overrides,
  }
}

function run(finishedAt: string, overrides: Partial<CoverageRun> = {}): CoverageRun {
  return {
    source: 'yad2',
    transaction_type: 'rent',
    finished_at: finishedAt,
    status: 'succeeded',
    truncated: false,
    scope_kind: 'neighborhoods',
    neighborhoods: ['Neve Tzedek'],
    group_windows: null,
    min_rooms: null,
    max_rooms: null,
    min_price: null,
    max_price: null,
    ...overrides,
  }
}

const NOW = new Date('2026-10-27T12:00:00Z')
const row = (last_seen_at: string | null, extra: Partial<{ source_url: string; published_at: string }> = {}) => ({
  source_url: extra.source_url ?? null,
  published_at: extra.published_at ?? null,
  last_seen_at,
})

test('a listing with no last_seen_at and no covering runs is legacy', () => {
  assert.equal(withFreshness(listing('yad2'), row(null), [], NOW).freshness, 'legacy')
})

test('a listing seen by the latest covering run is active', () => {
  const seen = '2026-10-27T10:00:00Z'
  assert.equal(withFreshness(listing('yad2'), row(seen), [run(seen)], NOW).freshness, 'active')
})

test('stale and inactive follow the coverage-based thresholds', () => {
  const l = listing('yad2')
  const seen = row('2026-10-10T00:00:00Z')
  const stale = [run('2026-10-20T00:00:00Z'), run('2026-10-21T00:00:00Z')]
  assert.equal(withFreshness(l, seen, stale, NOW).freshness, 'stale')
  const inactive = [...stale, run('2026-10-22T00:00:00Z')]
  assert.equal(withFreshness(l, seen, inactive, NOW).freshness, 'inactive')
})

test('runs for another neighborhood or deal type never age the listing', () => {
  const l = listing('yad2')
  const seen = row('2026-10-10T00:00:00Z')
  const other = [1, 2, 3].map((d) => run(`2026-10-1${d}T12:00:00Z`, { neighborhoods: ['Old North'] }))
  const sale = [1, 2, 3].map((d) => run(`2026-10-1${d}T12:00:00Z`, { transaction_type: 'sale' }))
  assert.equal(withFreshness(l, seen, [...other, ...sale], NOW).freshness, 'active')
})

test('unknown rooms or price stay null, so a filtered run does not cover the listing', () => {
  const l = listing('yad2', { known: { price: false, rooms: false, surface: true }, price: 0, rooms: 0 })
  const input = freshnessInput(l, row(null))
  assert.equal(input.rooms, null)
  assert.equal(input.price, null)
  const filtered = [1, 2, 3].map((d) => run(`2026-10-1${d}T12:00:00Z`, { min_rooms: 2 }))
  assert.equal(withFreshness(l, row('2026-10-01T00:00:00Z'), filtered, NOW).freshness, 'active')
})

test('a merged card takes the most active status of its source listings', () => {
  const madlan = { ...listing('madlan'), freshness: 'inactive' as const }
  const yad2 = { ...listing('yad2'), freshness: 'active' as const }
  const card = { ...madlan, listedAt: [madlan, yad2].map((l) => ({ source: l.source, url: l.url, id: l.id })) }
  assert.equal(resolveCardFreshness([card], [madlan, yad2])[0].freshness, 'active')
})

test('a Facebook card counts the duplicate posts merged into alsoPostedAt', () => {
  const rep = { ...listing('facebook'), freshness: 'stale' as const }
  const dup = { ...listing('facebook'), freshness: 'legacy' as const }
  const card = { ...rep, alsoPostedAt: [dup.url] }
  assert.equal(resolveCardFreshness([card], [rep, dup])[0].freshness, 'legacy')
})

test('freshness survives real cross-source dedupe and nothing is filtered out by status', () => {
  const shared = { street: 'שבזי 10', surface: 90, floor: 2, rooms: 3, price: 9_000 }
  const a = { ...listing('yad2', shared), freshness: 'inactive' as const }
  const b = { ...listing('madlan', shared), freshness: 'legacy' as const }
  const lone = { ...listing('yad2', { street: 'אחר 5', surface: 50 }), freshness: 'inactive' as const }
  const cards = resolveCardFreshness(dedupeAcrossSources([a, b, lone]), [a, b, lone])
  const statuses = cards.map((c) => c.freshness).sort()
  assert.equal(cards.length, 2)
  assert.deepEqual(statuses, ['inactive', 'legacy'])
  assert.equal(filterListings(cards, EMPTY_FILTERS, 'all').length, 2)
})

test('cards with no freshness data are returned unchanged', () => {
  const l = listing('yad2')
  assert.equal(resolveCardFreshness([l], [l])[0].freshness, undefined)
})
