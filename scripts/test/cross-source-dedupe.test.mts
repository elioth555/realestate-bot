/**
 * Read-time cross-source dedupe (Facebook / Yad2 / Madlan). Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/cross-source-dedupe.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMENITY_KEYS, listingLinks, listingSources, type AmenityKey, type Listing, type Source, type TriState } from '../../lib/listings.ts'
import { EMPTY_FILTERS, filterListings } from '../../lib/filters.ts'
import { dedupeAcrossSources, normalizeAddress, normalizePhone } from '../../lib/cross-source-dedupe.ts'

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
    street: 'דיזנגוף 100',
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
    photos: [],
    image: null,
    ...overrides,
  }
}

const POST =
  'דירת 3 חדרים מרווחת ומוארת ברחוב שקט בצפון הישן קרוב לים ולכיכר דיזנגוף קומה שנייה עם מרפסת שמש גדולה מטבח משופץ כניסה מיידית'

test('normalizers: address forms agree, placeholder phones are dropped', () => {
  assert.equal(normalizeAddress('רחוב דיזנגוף 100').address, normalizeAddress('דיזנגוף 100, הצפון הישן').address)
  assert.equal(normalizeAddress('הירדן').address, null)
  assert.equal(normalizePhone('+972-50-245-1312'), '0502451312')
  assert.equal(normalizePhone('0500000000'), null)
  assert.equal(normalizePhone(''), null)
})

test('same apartment on Facebook + Yad2 merges into one card with both links', () => {
  const fb = listing('facebook', { street: 'רחוב דיזנגוף 100', phone: '050-245-1312', price: 8_800 })
  const y2 = listing('yad2', { street: 'דיזנגוף 100, הצפון הישן', photos: ['a.jpg', 'b.jpg'] })
  const out = dedupeAcrossSources([fb, y2])
  assert.equal(out.length, 1)
  assert.deepEqual(listingSources(out[0]).sort(), ['facebook', 'yad2'])
  assert.deepEqual(listingLinks(out[0]).map((l) => l.url).sort(), [fb.url, y2.url].sort())
  assert.deepEqual(out[0].phones, ['050-245-1312'])
})

test('same apartment on Yad2 + Madlan merges', () => {
  const out = dedupeAcrossSources([listing('yad2'), listing('madlan', { surface: 76 })])
  assert.equal(out.length, 1)
  assert.deepEqual(listingSources(out[0]).sort(), ['madlan', 'yad2'])
})

test('same apartment on all 3 sources becomes one card; photos merged without duplicates', () => {
  const fb = listing('facebook', { phone: '0502451312', photos: ['https://cdn/x.jpg?v=1'] })
  const y2 = listing('yad2', { photos: ['https://cdn/x.jpg?v=2', 'https://cdn/y.jpg', 'https://cdn/z.jpg'] })
  const md = listing('madlan', { photos: ['https://cdn/y.jpg', 'https://cdn/w.jpg'] })
  const out = dedupeAcrossSources([fb, y2, md])
  assert.equal(out.length, 1)
  const card = out[0]
  assert.deepEqual(listingSources(card).sort(), ['facebook', 'madlan', 'yad2'])
  assert.equal(listingLinks(card).length, 3)
  assert.equal(card.source, 'yad2', 'most complete record (most photos) is the representative')
  assert.deepEqual(card.photos, ['https://cdn/x.jpg?v=2', 'https://cdn/y.jpg', 'https://cdn/z.jpg', 'https://cdn/w.jpg'])
  assert.deepEqual(card.phones, ['0502451312'])
})

test('same street but a different apartment does not merge', () => {
  const differentNumber = dedupeAcrossSources([listing('yad2'), listing('madlan', { street: 'דיזנגוף 140' })])
  assert.equal(differentNumber.length, 2)
  // No house number: the street name alone is never enough.
  const streetOnly = dedupeAcrossSources([listing('yad2', { street: 'דיזנגוף' }), listing('madlan', { street: 'דיזנגוף' })])
  assert.equal(streetOnly.length, 2)
})

test('same price, rooms and size but a different apartment does not merge', () => {
  const out = dedupeAcrossSources([
    listing('yad2', { street: 'גורדון 12' }),
    listing('madlan', { street: 'בן יהודה 40' }),
    listing('facebook', { street: '', description: POST }),
  ])
  assert.equal(out.length, 3)
})

test('same phone but clearly different apartments does not merge (broker with many listings)', () => {
  const broker = '052-1234567'
  const out = dedupeAcrossSources([
    listing('facebook', { street: '', phone: broker, rooms: 2, surface: 50 }),
    listing('yad2', { street: '', phone: broker, rooms: 4, surface: 110, price: 15_000 }),
    listing('madlan', { street: 'אבן גבירול 20', phone: broker }),
    listing('yad2', { street: 'דיזנגוף 100', phone: broker, floor: 7 }),
  ])
  assert.equal(out.length, 4)
})

test('a repost with a slightly different description merges when the details also agree', () => {
  const reposted = POST.replace('כניסה מיידית', 'כניסה גמישה, ללא תיווך')
  const out = dedupeAcrossSources([
    listing('facebook', { street: '', description: POST }),
    listing('yad2', { street: '', description: reposted }),
  ])
  assert.equal(out.length, 1)
  // Same text but a different size is a different unit in the same building.
  const otherUnit = dedupeAcrossSources([
    listing('facebook', { street: '', description: POST }),
    listing('yad2', { street: '', description: reposted, surface: 95 }),
  ])
  assert.equal(otherUnit.length, 2)
})

test('a missing phone does not block a merge; the known phone is kept', () => {
  const out = dedupeAcrossSources([listing('yad2', { phone: '' }), listing('facebook', { phone: '0541112233' })])
  assert.equal(out.length, 1)
  assert.equal(out[0].phone, '0541112233')
})

test('conflicting source data never merges', () => {
  const conflicts: Partial<Listing>[] = [
    { floor: 5 },
    { rooms: 4 },
    { price: 12_000 },
    { surface: 100 },
    { dealType: 'sale', price: 9_000 },
    { neighborhood: 'Florentin' },
    { phone: '0507654321' },
  ]
  for (const c of conflicts) {
    const out = dedupeAcrossSources([listing('yad2', { phone: '0523456789' }), listing('madlan', { phone: '0523456789', ...c })])
    assert.equal(out.length, 2, `should not merge with ${JSON.stringify(c)}`)
  }
})

test('two listings from the same source are never merged here', () => {
  assert.equal(dedupeAcrossSources([listing('yad2'), listing('yad2')]).length, 2)
})

test('unknown fields on the representative are filled from the other sources', () => {
  const fb = listing('facebook', { known: { price: true, rooms: true, surface: false }, surface: 0, photos: ['1', '2', '3', '4', '5'] })
  const y2 = listing('yad2', { features: features({ elevator: 'yes' }) })
  const out = dedupeAcrossSources([fb, y2])
  assert.equal(out.length, 1)
  const [card] = out
  assert.equal(card.source, 'facebook')
  assert.equal(card.surface, 75)
  assert.equal(card.known.surface, true)
  assert.equal(card.features.elevator, 'yes')
  assert.ok(card.amenities.includes('elevator'))
})

test('same address with neither size nor floor known is not enough to merge', () => {
  const thin = { floor: null, surface: 0, known: { price: true, rooms: true, surface: false } }
  assert.equal(dedupeAcrossSources([listing('yad2', thin), listing('madlan', thin)]).length, 2)
})

test('a merged cluster appears once in filter results and filters apply to the merged listing', () => {
  const deduped = dedupeAcrossSources([listing('facebook', { phone: '0502451312' }), listing('yad2'), listing('madlan')])
  assert.equal(filterListings(deduped, EMPTY_FILTERS, 'all').length, 1)
  assert.equal(filterListings(deduped, { ...EMPTY_FILTERS, neighborhoods: ['Old North'] }, 'rent').length, 1)
  assert.equal(filterListings(deduped, { ...EMPTY_FILTERS, maxPrice: '8000' }, 'all').length, 0)
  assert.equal(filterListings(deduped, EMPTY_FILTERS, 'sale').length, 0)
})
