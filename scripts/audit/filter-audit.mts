/**
 * Read-only audit of dashboard filtering across all sources, through the real read path
 * (rowToListing + Facebook dedupe) and the real filterListings. Never writes.
 * Run:
 *   node --env-file-if-exists=/vercel/share/.env.project --experimental-strip-types \
 *     --import ./scripts/test/register.mjs scripts/audit/filter-audit.mts
 */
import { rowToListing, type PropertyRow } from '../../lib/supabase.ts'
import { dedupeFacebookListings } from '../../lib/facebook-dedupe.ts'
import { mapFacebookItem } from '../../lib/facebook-mapper.ts'
import { EMPTY_FILTERS, filterListings, type DealScope, type Filters } from '../../lib/filters.ts'
import { CANONICAL_NEIGHBORHOODS } from '../../lib/geo/canonical-neighborhoods.ts'
import type { AmenityKey, Listing } from '../../lib/listings.ts'
import { normalizeDealType, normalizeNeighborhood } from '../../lib/normalize.ts'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
if (!url || !key) throw new Error('Supabase env vars missing')

const rows: PropertyRow[] = []
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(`${url}/rest/v1/properties?select=*&order=id&limit=1000&offset=${offset}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  const page = (await res.json()) as PropertyRow[]
  rows.push(...page)
  if (page.length < 1000) break
}
const all = rows.map((r) => rowToListing(r))
const listings = [...all.filter((l) => l.source !== 'facebook'), ...dedupeFacebookListings(all.filter((l) => l.source === 'facebook'))]
const SOURCES = ['facebook', 'yad2', 'madlan'] as const
const bySource = (ls: Listing[]) => SOURCES.map((s) => `${s} ${ls.filter((l) => l.source === s).length}`).join(' / ')
const run = (f: Partial<Filters>, scope: DealScope = 'all') => filterListings(listings, { ...EMPTY_FILTERS, ...f }, scope)
const one = (l: Listing, f: Partial<Filters>, scope: DealScope = 'all') =>
  filterListings([l], { ...EMPTY_FILTERS, ...f }, scope).length === 1

console.log('displayed listings:', bySource(listings))

// Canonical names must stay distinct after normalizeNeighborhood, or one zone's filter would pull in another.
const keys = new Map<string, string[]>()
for (const n of CANONICAL_NEIGHBORHOODS) {
  const k = normalizeNeighborhood(n)
  keys.set(k, [...(keys.get(k) ?? []), n])
}
console.log('canonical names that collapse:', JSON.stringify([...keys.values()].filter((v) => v.length > 1)))
console.log('canonical names renamed by normalizeNeighborhood:', JSON.stringify(CANONICAL_NEIGHBORHOODS.filter((n) => normalizeNeighborhood(n) !== n)))

for (const s of SOURCES) {
  const ls = listings.filter((l) => l.source === s)
  const withN = ls.filter((l) => l.neighborhood)
  const excluded = withN.filter((l) => !one(l, { neighborhoods: [l.neighborhood] }))
  const nonCanonical = withN.filter((l) => l.city === 'תל אביב' && !CANONICAL_NEIGHBORHOODS.includes(l.neighborhood))
  const roomsKnown = ls.filter((l) => l.known.rooms)
  const roomsExcluded = roomsKnown.filter((l) => !one(l, { minRooms: String(l.rooms), maxRooms: String(l.rooms) }))
  const leak = ls.filter((l) => l.features && Object.entries(l.features).some(([k, v]) => v !== 'yes' && one(l, { amenities: [k as AmenityKey] }) && !['elevator', 'petFriendly'].includes(k)))
  console.log(`\n[${s}] total ${ls.length}`)
  console.log('  with canonical neighborhood', withN.length, '| excluded by own neighborhood filter', excluded.length, '| Tel Aviv non-canonical names', nonCanonical.length)
  for (const l of excluded.slice(0, 5)) console.log('    excluded', l.id, l.neighborhood)
  console.log('  rooms known', roomsKnown.length, '| excluded by own rooms filter', roomsExcluded.length)
  console.log('  strict amenity matched without YES', leak.length)
}

// Facebook transaction type: the stored column vs the current parser.
const fbRows = rows.filter((r) => /facebook/i.test(String(r.source)))
const dealMismatch = fbRows
  .map((r) => ({ id: r.id, stored: r.transaction_type, parsed: r.description ? mapFacebookItem({ text: r.description, url: r.source_url }).property.transaction_type : null }))
  .filter((x) => x.parsed && x.stored && normalizeDealType(String(x.stored)) !== normalizeDealType(String(x.parsed)))
console.log('\nFacebook rows: stored vs re-parsed deal type disagree', dealMismatch.length, JSON.stringify(dealMismatch.slice(0, 8)))
console.log('Facebook rows with no stored deal type', fbRows.filter((r) => !r.transaction_type).length)
const suspicious = listings.filter((l) => (l.dealType === 'rent' && l.known.price && l.price >= 400_000) || (l.dealType === 'sale' && l.known.price && l.price < 30_000))
console.log('price looks like the other deal type:', suspicious.length, JSON.stringify(suspicious.slice(0, 8).map((l) => [l.source, l.id, l.dealType, l.price])))

const scenarios: [string, Partial<Filters>, DealScope?][] = [
  ['Neve Tzedek', { neighborhoods: ['Neve Tzedek'] }],
  ['Old North', { neighborhoods: ['Old North'] }],
  ['Lev HaIr', { neighborhoods: ['Lev HaIr'] }],
  ['Florentin', { neighborhoods: ['Florentin'] }],
  ['Old North + 3 rooms', { neighborhoods: ['Old North'], minRooms: '3', maxRooms: '3' }],
  ['Neve Tzedek + parking', { neighborhoods: ['Neve Tzedek'], amenities: ['parking'] }],
  ['Lev HaIr + protected space', { neighborhoods: ['Lev HaIr'], amenities: ['mamad'] }],
  ['Rent 2-4 rooms + max 16,000', { minRooms: '2', maxRooms: '4', maxPrice: '16000' }, 'rent'],
  ['Rent', {}, 'rent'],
  ['Sale', {}, 'sale'],
]
console.log('\nscenario results (facebook / yad2 / madlan):')
for (const [name, f, scope] of scenarios) console.log(' ', name.padEnd(30), bySource(run(f, scope)))
console.log('  canonical names present in data:', JSON.stringify([...new Set(listings.map((l) => l.neighborhood).filter(Boolean))].slice(0, 40)))

const fb = listings.filter((l) => l.source === 'facebook')
const fbNR = fb.find((l) => l.neighborhood && l.known.rooms)
if (fbNR) console.log('FB neighborhood+rooms', fbNR.id, fbNR.neighborhood, fbNR.rooms, one(fbNR, { neighborhoods: [fbNR.neighborhood], minRooms: String(fbNR.rooms), maxRooms: String(fbNR.rooms) }))
for (const t of ['mamad', 'miklat', 'mamak'] as const) {
  const l = fb.find((x) => x.protectedSpaceType === t && x.features.mamad === 'yes')
  console.log(`FB ${t}`, l ? `${l.id} matches protected-space filter: ${one(l, { amenities: ['mamad'] })}` : 'none found')
}
const unk = fb.find((l) => l.features.parking === 'unknown')
if (unk) console.log('FB unknown parking', unk.id, 'matches parking filter:', one(unk, { amenities: ['parking'] }))
const unkPrice = fb.find((l) => !l.known.price)
if (unkPrice) console.log('FB unknown price', unkPrice.id, 'no filter:', one(unkPrice, {}), '| max 16000:', one(unkPrice, { maxPrice: '16000' }))
