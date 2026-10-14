/**
 * Rent + Sale support for Yad2 and Madlan, and identical filtering across all six source/deal-type combinations. Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/sale-support.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMENITY_KEYS, type AmenityKey, type Listing, type Source, type TriState } from '../../lib/listings.ts'
import { EMPTY_FILTERS, filterListings, type DealScope, type Filters } from '../../lib/filters.ts'
import {
  buildSearchUrls,
  validateCriteria,
  yad2TransactionTypeFromActorInput,
  yad2TransactionTypeFromUrl,
} from '../../lib/yad2-search.ts'
import { mapYad2Item } from '../../lib/yad2-mapper.ts'
import { buildMadlanActorInputs, validateMadlanCriteria } from '../../lib/madlan-search.ts'
import { mapMadlanItem } from '../../lib/madlan-mapper.ts'

function yad2Urls(transaction_type: string, extra: Record<string, unknown> = {}) {
  const v = validateCriteria({ city: 'Tel Aviv', transaction_type, ...extra })
  assert.ok(v.ok, JSON.stringify(v))
  return buildSearchUrls(v.data).urls
}

test('Yad2 rent: start URL uses /realestate/rent', () => {
  const [url] = yad2Urls('rent', { max_price: 12000 })
  assert.equal(new URL(url).pathname, '/realestate/rent')
  assert.equal(new URL(url).searchParams.get('maxPrice'), '12000')
  assert.equal(yad2TransactionTypeFromUrl(url), 'rent')
})

test('Yad2 sale: start URL uses /realestate/forsale with the same city params and no price cap added', () => {
  const [rentUrl] = yad2Urls('rent')
  const [saleUrl] = yad2Urls('sale', { max_price: 4_500_000 })
  const sale = new URL(saleUrl)
  assert.equal(sale.pathname, '/realestate/forsale')
  assert.equal(sale.searchParams.get('maxPrice'), '4500000')
  assert.equal(yad2TransactionTypeFromUrl(saleUrl), 'sale')
  for (const key of ['topArea', 'area', 'city']) {
    assert.equal(sale.searchParams.get(key), new URL(rentUrl).searchParams.get(key))
  }
  assert.equal(new URL(yad2Urls('sale')[0]).searchParams.has('maxPrice'), false)
})

test('Yad2 rejects deal types other than rent or sale', () => {
  assert.equal(validateCriteria({ city: 'Tel Aviv', transaction_type: 'lease' }).ok, false)
})

test('Yad2 webhook deal type comes from the run input start URLs', () => {
  const rent = yad2TransactionTypeFromActorInput({ start_urls: [{ url: yad2Urls('rent')[0] }] })
  const sale = yad2TransactionTypeFromActorInput({ start_urls: [yad2Urls('sale')[0]] })
  assert.deepEqual(rent, { ok: true, transactionType: 'rent' })
  assert.deepEqual(sale, { ok: true, transactionType: 'sale' })
  const mixed = yad2TransactionTypeFromActorInput({ start_urls: [yad2Urls('rent')[0], yad2Urls('sale')[0]] })
  assert.equal(mixed.ok, false, 'rent and sale must never be mixed in one run')
  assert.equal(yad2TransactionTypeFromActorInput({ start_urls: ['https://www.yad2.co.il/item/abc'] }).ok, false)
  assert.equal(yad2TransactionTypeFromActorInput({}).ok, false)
})

test('Yad2 mapper: rent by default, sale when the run is a sale; every other field is identical', () => {
  const item = {
    item_id: 'abc123',
    item_url: 'https://www.yad2.co.il/realestate/item/abc123',
    price: 3_950_000,
    rooms: 4,
    square_meters: 98,
    floor: 3,
    street: 'דיזנגוף',
    neighborhood: 'הצפון הישן',
    city: 'תל אביב יפו',
  }
  const rent = mapYad2Item(item)
  const sale = mapYad2Item(item, 'sale')
  assert.equal(rent.transaction_type, 'rent')
  assert.equal(sale.transaction_type, 'sale')
  assert.deepEqual({ ...sale, transaction_type: 'rent' }, rent)
})

function madlanInput(transaction_type: string, extra: Record<string, unknown> = {}) {
  const v = validateMadlanCriteria({ city: 'Tel Aviv', transaction_type, ...extra })
  assert.ok(v.ok, JSON.stringify(v))
  return buildMadlanActorInputs(v.data)
}

test('Madlan rent: actor input dealType = "rent"', () => {
  const [input] = madlanInput('rent', { max_price: 12000 })
  assert.equal(input.dealType, 'rent')
  assert.equal(input.maxPrice, 12000)
})

test('Madlan sale: actor input dealType = "buy", sale prices pass through uncapped', () => {
  const [input] = madlanInput('sale', { min_price: 2_000_000, max_price: 6_000_000 })
  assert.equal(input.dealType, 'buy')
  assert.equal(input.minPrice, 2_000_000)
  assert.equal(input.maxPrice, 6_000_000)
  assert.equal('maxPrice' in madlanInput('sale')[0], false)
})

test('Madlan mapper: dealType rent → rent, buy → sale', () => {
  const base = { id: 'm1', url: 'https://www.madlan.co.il/listings/m1', price: 9200, rooms: 3, city: 'תל אביב יפו' }
  assert.equal(mapMadlanItem({ ...base, dealType: 'rent' }).property.transaction_type, 'rent')
  assert.equal(mapMadlanItem({ ...base, dealType: 'buy', price: 3_400_000 }).property.transaction_type, 'sale')
})

function features(overrides: Partial<Record<AmenityKey, TriState>>): Record<AmenityKey, TriState> {
  const all = Object.fromEntries(AMENITY_KEYS.map((k) => [k, 'unknown'])) as Record<AmenityKey, TriState>
  return { ...all, ...overrides }
}

function listing(source: Source, dealType: 'rent' | 'sale'): Listing {
  const f = features({ parking: 'yes', balcony: 'no', mamad: 'yes', elevator: 'unknown' })
  return {
    id: `${source}-${dealType}`,
    title: 'Apartment',
    description: '',
    dealType,
    price: dealType === 'rent' ? 11_000 : 3_500_000,
    city: 'Tel Aviv',
    neighborhood: 'Old North',
    street: 'Dizengoff',
    rooms: 3,
    surface: 75,
    floor: 2,
    propertyType: 'Apartment',
    amenities: AMENITY_KEYS.filter((k) => f[k] === 'yes'),
    features: f,
    protectedSpaceType: 'mamad',
    entryDate: null,
    known: { price: true, rooms: true, surface: true },
    phone: '',
    source,
    url: `https://example.com/${source}/${dealType}`,
    publishedAt: null,
    publishedMinutesAgo: 0,
    photos: [],
    image: null,
  }
}

const SOURCES: Source[] = ['facebook', 'yad2', 'madlan']
const DEALS = ['rent', 'sale'] as const
const included = (l: Listing, filters: Partial<Filters>, scope: DealScope) =>
  filterListings([l], { ...EMPTY_FILTERS, ...filters }, scope).length === 1

const SCENARIOS: [string, Partial<Filters>, DealScope, Record<'rent' | 'sale', boolean>][] = [
  ['Rent tab', {}, 'rent', { rent: true, sale: false }],
  ['Sale tab', {}, 'sale', { rent: false, sale: true }],
  ['All tab', {}, 'all', { rent: true, sale: true }],
  ['own neighborhood', { neighborhoods: ['Old North'] }, 'all', { rent: true, sale: true }],
  ['other neighborhood', { neighborhoods: ['Florentin'] }, 'all', { rent: false, sale: false }],
  ['rooms exactly 3', { minRooms: '3', maxRooms: '3' }, 'all', { rent: true, sale: true }],
  ['rooms 3.5+', { minRooms: '3.5' }, 'all', { rent: false, sale: false }],
  ['surface 70–80', { minSurface: '70', maxSurface: '80' }, 'all', { rent: true, sale: true }],
  ['rent max ₪12,000', { maxPrice: '12000' }, 'rent', { rent: true, sale: false }],
  ['rent max ₪10,000', { maxPrice: '10000' }, 'rent', { rent: false, sale: false }],
  ['sale ₪3M–₪4M', { minPrice: '3000000', maxPrice: '4000000' }, 'sale', { rent: false, sale: true }],
  ['sale max ₪3M', { maxPrice: '3000000' }, 'sale', { rent: false, sale: false }],
  ['parking (YES)', { amenities: ['parking'] }, 'all', { rent: true, sale: true }],
  ['balcony (NO)', { amenities: ['balcony'] }, 'all', { rent: false, sale: false }],
  ['elevator (UNKNOWN, permissive)', { amenities: ['elevator'] }, 'all', { rent: true, sale: true }],
  ['protected space', { amenities: ['mamad'] }, 'all', { rent: true, sale: true }],
]

for (const [name, filters, scope, expected] of SCENARIOS) {
  test(`six combinations agree: ${name}`, () => {
    for (const deal of DEALS) {
      for (const source of SOURCES) {
        assert.equal(included(listing(source, deal), filters, scope), expected[deal], `${source} ${deal}`)
      }
    }
  })
}
