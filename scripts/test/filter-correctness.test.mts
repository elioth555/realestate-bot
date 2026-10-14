/**
 * Source-independent filtering + Facebook deal-type/price regressions from real production posts. Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/filter-correctness.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMENITY_KEYS, type AmenityKey, type Listing, type Source, type TriState } from '../../lib/listings.ts'
import { EMPTY_FILTERS, filterListings, type DealScope, type Filters } from '../../lib/filters.ts'
import { mapFacebookItem } from '../../lib/facebook-mapper.ts'
import { dealTypeConsistentWithPrice } from '../../lib/supabase.ts'

function features(overrides: Partial<Record<AmenityKey, TriState>>): Record<AmenityKey, TriState> {
  const all = Object.fromEntries(AMENITY_KEYS.map((k) => [k, 'unknown'])) as Record<AmenityKey, TriState>
  return { ...all, ...overrides }
}

function listing(source: Source, overrides: Partial<Listing> = {}): Listing {
  const f = overrides.features ?? features({ parking: 'yes', balcony: 'no', mamad: 'yes', elevator: 'unknown' })
  return {
    id: `${source}-1`,
    title: 'Apartment',
    description: '',
    dealType: 'rent',
    price: 11_000,
    city: 'Tel Aviv',
    neighborhood: 'Old North',
    street: 'Dizengoff',
    rooms: 3,
    surface: 75,
    floor: 2,
    propertyType: 'Apartment',
    amenities: AMENITY_KEYS.filter((k) => f[k] === 'yes'),
    features: f,
    protectedSpaceType: f.mamad === 'yes' ? 'mamad' : null,
    entryDate: null,
    known: { price: true, rooms: true, surface: true },
    phone: '',
    source,
    url: `https://example.com/${source}`,
    publishedAt: null,
    publishedMinutesAgo: 0,
    photos: [],
    image: null,
    ...overrides,
  }
}

const SOURCES: Source[] = ['facebook', 'yad2', 'madlan']
const matches = (l: Listing, filters: Partial<Filters>, scope: DealScope = 'all') =>
  filterListings([l], { ...EMPTY_FILTERS, ...filters }, scope).length === 1

const SCENARIOS: [string, Partial<Filters>, DealScope, boolean][] = [
  ['no filters', {}, 'all', true],
  ['own neighborhood', { neighborhoods: ['Old North'] }, 'all', true],
  ['other neighborhood', { neighborhoods: ['Florentin'] }, 'all', false],
  ['exact rooms 3', { minRooms: '3', maxRooms: '3' }, 'all', true],
  ['rooms 3.5+', { minRooms: '3.5' }, 'all', false],
  ['rooms 2-4 + max 16,000', { minRooms: '2', maxRooms: '4', maxPrice: '16000' }, 'rent', true],
  ['max price 10,000', { maxPrice: '10000' }, 'all', false],
  ['surface 70-80', { minSurface: '70', maxSurface: '80' }, 'all', true],
  ['surface 90+', { minSurface: '90' }, 'all', false],
  ['parking (YES)', { amenities: ['parking'] }, 'all', true],
  ['balcony (NO)', { amenities: ['balcony'] }, 'all', false],
  ['garden (UNKNOWN, strict)', { amenities: ['garden'] }, 'all', false],
  ['elevator (UNKNOWN, permissive)', { amenities: ['elevator'] }, 'all', true],
  ['protected space (Mamad)', { amenities: ['mamad'] }, 'all', true],
  ['Rent scope', {}, 'rent', true],
  ['Sale scope', {}, 'sale', false],
  ['Old North + 3 rooms + parking', { neighborhoods: ['Old North'], minRooms: '3', maxRooms: '3', amenities: ['parking'] }, 'rent', true],
]

for (const [name, filters, scope, expected] of SCENARIOS) {
  test(`source-independent: ${name} → ${expected ? 'all three included' : 'all three excluded'}`, () => {
    for (const source of SOURCES) assert.equal(matches(listing(source), filters, scope), expected, source)
  })
}

test('unknown rooms / surface / price never satisfy a range filter, but still show without one', () => {
  const unknown = listing('facebook', { rooms: 0, surface: 0, price: 0, known: { price: false, rooms: false, surface: false } })
  assert.equal(matches(unknown, {}), true)
  assert.equal(matches(unknown, { minRooms: '2' }), false)
  assert.equal(matches(unknown, { maxRooms: '4' }), false)
  assert.equal(matches(unknown, { minSurface: '50' }), false)
  assert.equal(matches(unknown, { maxSurface: '100' }), false)
  assert.equal(matches(unknown, { minPrice: '5000' }), false)
  assert.equal(matches(unknown, { maxPrice: '16000' }), false)
})

test('half rooms match exactly', () => {
  for (const rooms of [2, 2.5, 3, 3.5]) {
    const l = listing('facebook', { rooms })
    assert.equal(matches(l, { minRooms: String(rooms), maxRooms: String(rooms) }), true, String(rooms))
    assert.equal(matches(l, { minRooms: String(rooms + 0.5) }), false, String(rooms))
  }
})

test('Miklat and Mamak satisfy the broad protected-space filter; explicit NO never does', () => {
  for (const type of ['miklat', 'mamak'] as const) {
    assert.equal(matches(listing('facebook', { protectedSpaceType: type }), { amenities: ['mamad'] }), true, type)
  }
  assert.equal(matches(listing('yad2', { features: features({ mamad: 'no' }), protectedSpaceType: null }), { amenities: ['mamad'] }), false)
  assert.equal(matches(listing('madlan', { features: features({ elevator: 'no' }) }), { amenities: ['elevator'] }), false)
  assert.equal(matches(listing('facebook', { features: features({ petFriendly: 'no' }) }), { amenities: ['petFriendly'] }), false)
})

test('Rent and Sale scopes never cross', () => {
  const sale = listing('facebook', { dealType: 'sale', price: 3_500_000 })
  assert.equal(matches(sale, {}, 'sale'), true)
  assert.equal(matches(sale, {}, 'rent'), false)
  assert.equal(matches(listing('yad2'), {}, 'sale'), false)
})

// Real production posts (trimmed to the decisive sentences).
test('post 726: pre-sale with "rental potential" is a sale at ₪3,520,000', () => {
  const p = mapFacebookItem({
    text: 'רבי נחל 28 | תל אביב הזדמנות לרכישת דירת 3 חדרים בפרויקט חדש בשלב הפריסייל, בשכונת נחלת יצחק המתחדשת בתל אביב. תשואה טובה יותר ופוטנציאל גבוה יותר להשכרה. קומה 4 - ללא חניה. מחיר מחירון : 3,520,000 תנאי תשלום 15/85',
  }).property
  assert.equal(p.transaction_type, 'sale')
  assert.equal(p.price, 3_520_000)
})

test('post 733: rental that mentions a ₪2M renovation is ₪29,000/month', () => {
  const p = mapFacebookItem({
    text: '🔥 להשכרה | מיני פנטהאוז יוקרתי במגדל 🔥 הנכס עבר השקעה של למעלה מ־2 מיליון ₪ ברמת הגמר והעיצוב. 💰 29,000 ש"ח לחודש 📞 לפרטים נוספים',
  }).property
  assert.equal(p.transaction_type, 'rent')
  assert.equal(p.price, 29_000)
})

test('stored deal type is corrected only when the price makes it impossible', () => {
  assert.equal(dealTypeConsistentWithPrice('sale', 3_800), 'rent')
  assert.equal(dealTypeConsistentWithPrice('rent', 3_520_000), 'sale')
  assert.equal(dealTypeConsistentWithPrice('rent', 11_000), 'rent')
  assert.equal(dealTypeConsistentWithPrice('sale', 2_900_000), 'sale')
  assert.equal(dealTypeConsistentWithPrice('sale', null), 'sale')
})
