/**
 * Madlan mapper tests. Offline: no Apify, no Supabase.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/madlan-mapper.test.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { mapMadlanItem, type MadlanItem } from '../../lib/madlan-mapper.ts'
import { deriveFeatures } from '../../lib/matching/features.ts'
import { normalizeCity, normalizeNeighborhood } from '../../lib/normalize.ts'
import { validatePropertyInput } from '../../lib/import-listing.ts'

const sample: MadlanItem = JSON.parse(
  readFileSync(new URL('../fixtures/madlan-sample.json', import.meta.url), 'utf8'),
)
const withChanges = (changes: MadlanItem): MadlanItem => ({ ...sample, ...changes })

// Same column → amenity mapping and call shape as the dashboard reader in lib/supabase.ts (non-Yad2 → 'explicit').
const COLUMNS: [string, string][] = [
  ['parking', 'parking'], ['mamad', 'mamad'], ['balcony', 'balcony'], ['elevator', 'elevator'],
  ['furnished', 'furnished'], ['terrace', 'terrace'], ['garden', 'garden'], ['pool', 'pool'],
  ['gym', 'gym'], ['seaView', 'sea_view'], ['petFriendly', 'pet_friendly'],
]
function readPathDerive(row: Record<string, unknown>) {
  return deriveFeatures({
    flags: Object.fromEntries(COLUMNS.map(([key, col]) => [key, (row[col] ?? null) as boolean | null])),
    flagSemantics: 'explicit',
    protectedSpaceFlagType: 'mamad',
    texts: [row.title as string | undefined, row.description as string | undefined],
    availableFrom: row.available_from as string | undefined,
  })
}

test('sample maps to the expected property row', () => {
  const { property } = mapMadlanItem(sample)
  assert.deepEqual(property, {
    description: 'חניה משותפת. מקלט מאובזר ומאורגן.',
    published_at: '2026-10-05T10:19:11.000Z',
    source: 'madlan',
    source_url: 'https://www.madlan.co.il/listings/et7XHWVdaoq',
    transaction_type: 'rent',
    property_type: 'apartment',
    city: 'תל אביב יפו',
    neighborhood: 'הצפון החדש החלק הצפוני',
    street: 'צירלסון 2',
    phone: '0545304084',
    price: 9200,
    rooms: 3,
    surface_m2: 90,
    floor: 2,
    parking: null,
    elevator: true,
    balcony: null,
    mamad: null,
    garden: null,
    pool: null,
    terrace: null,
    pet_friendly: null,
    furnished: null,
    renovated: true,
    new_building: null,
  })
  assert.equal(validatePropertyInput(property).ok, true, 'row passes the existing import validator')
})

test('city and neighborhood go through the existing normalization', () => {
  const { property } = mapMadlanItem(sample)
  assert.equal(normalizeCity(property.city as string), normalizeCity('Tel Aviv'))
  assert.equal(normalizeNeighborhood(property.neighborhood as string), 'New North')
})

test('parking=0 + "חניה משותפת" resolves to YES', () => {
  const { derived, property } = mapMadlanItem(sample)
  assert.equal(derived.features.parking, 'yes')
  assert.equal(property.parking, null, 'parking=0 is not stored as a NO')
})

test('hasSecureRoom=false + "מקלט" resolves to YES with type miklat', () => {
  const { derived, extras } = mapMadlanItem(sample)
  assert.equal(derived.features.mamad, 'yes')
  assert.equal(derived.protectedSpaceType, 'miklat')
  assert.equal(extras.protected_space_type, 'miklat')
})

test('null and unconfirmed false flags stay UNKNOWN; true stays YES', () => {
  const { features } = mapMadlanItem(sample).derived
  assert.equal(features.garden, 'unknown') // null
  assert.equal(features.terrace, 'unknown') // null
  assert.equal(features.petFriendly, 'unknown') // false, no text
  assert.equal(features.furnished, 'unknown') // false, no text
  assert.equal(features.pool, 'unknown') // false, no text
  assert.equal(features.balcony, 'unknown') // false, no text
  assert.equal(features.elevator, 'yes') // true
})

test('explicit negative text overrides a structured positive', () => {
  const elevator = mapMadlanItem(withChanges({ hasElevator: true, description: 'דירה יפה, אין מעלית' }))
  assert.equal(elevator.derived.features.elevator, 'no')
  const mamad = mapMadlanItem(withChanges({ hasSecureRoom: true, description: 'אין ממ"ד בדירה' }))
  assert.equal(mamad.derived.features.mamad, 'no')
  assert.equal(mamad.derived.protectedSpaceType, null)
})

test('explicit negative text turns false/null into NO', () => {
  const { features } = mapMadlanItem(withChanges({ petsAllowed: false, description: 'ללא בעלי חיים' })).derived
  assert.equal(features.petFriendly, 'no')
})

test('structured positive parking count is YES', () => {
  const { derived, property } = mapMadlanItem(withChanges({ parking: 1, description: null }))
  assert.equal(derived.features.parking, 'yes')
  assert.equal(property.parking, true)
})

test('dashboard read path re-derives exactly what the mapper derived', () => {
  const cases: MadlanItem[] = [
    sample,
    withChanges({ hasElevator: true, description: 'אין מעלית' }),
    withChanges({ hasSecureRoom: true, description: 'יש ממ"ד' }),
    withChanges({ hasSecureRoom: true, description: null }),
    withChanges({ hasSecureRoom: false, description: 'ממ"ק בקומה' }),
    withChanges({ parking: 2, hasGarden: true, isFurnished: true, description: 'ללא חיות מחמד' }),
  ]
  for (const item of cases) {
    const { property, derived } = mapMadlanItem(item)
    assert.deepEqual(readPathDerive(property), { ...derived, entryDate: readPathDerive(property).entryDate })
    assert.deepEqual(readPathDerive(property).features, derived.features)
    assert.equal(readPathDerive(property).protectedSpaceType, derived.protectedSpaceType)
  }
})

test('photos: strings and objects, de-duplicated, invalid dropped', () => {
  const { photoUrls } = mapMadlanItem(
    withChanges({
      images: [
        'https://images.madlan.co.il/a.jpg',
        { url: 'https://images.madlan.co.il/b.jpg' },
        'https://images.madlan.co.il/a.jpg',
        'not a url',
        null,
      ],
    }),
  )
  assert.deepEqual(photoUrls, ['https://images.madlan.co.il/a.jpg', 'https://images.madlan.co.il/b.jpg'])
})

test('extras keep fields that have no schema column', () => {
  const { extras } = mapMadlanItem(sample)
  assert.deepEqual(extras, {
    external_id: 'et7XHWVdaoq',
    address: 'צירלסון 2, תל אביב יפו',
    house_number: '2',
    latitude: 32.092546,
    longitude: 34.794077,
    total_floors: 4,
    vaad_bait: 250,
    price_per_sqm: 102,
    currency: 'ILS',
    property_condition: 'renovated',
    protected_space_type: 'miklat',
    air_conditioning: true,
    barrier_free: false,
    contact_name: 'רויטל',
    contact_type: 'private',
    has_agent: false,
    first_seen: '2026-10-05T10:19:11.000Z',
    scraped_at: '2026-10-05T12:33:36.872Z',
    floorplan_urls: [],
  })
})

test('edge cases: ground floor, sale, missing url, empty description', () => {
  const { property } = mapMadlanItem(
    withChanges({ floor: 'קרקע', dealType: 'buy', url: null, description: '  ', condition: 'needsRenovation' }),
  )
  assert.equal(property.floor, 0)
  assert.equal(property.transaction_type, 'sale')
  assert.equal(property.source_url, 'https://www.madlan.co.il/listings/et7XHWVdaoq')
  assert.equal('description' in property, false)
  assert.equal(property.renovated, false)
})
