/**
 * Facebook mapper tests. Offline: no Apify, no Supabase.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/facebook-mapper.test.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { mapFacebookItem, type FacebookItem } from '../../lib/facebook-mapper.ts'
import { deriveFeatures } from '../../lib/matching/features.ts'
import { normalizeCity } from '../../lib/normalize.ts'

const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'))
const sample: FacebookItem = load('facebook-sample.json')
const synthetic: Record<string, FacebookItem> = load('facebook-synthetic.json')
const map = (name: string) => mapFacebookItem(synthetic[name])

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
  })
}

test('real sample maps to the expected row', () => {
  const result = mapFacebookItem(sample)
  assert.deepEqual(result.property, {
    description: 'להשכרה 4 חדרים ברחוב דפנה תל אביב !!',
    published_at: '2026-10-06T09:36:42.000Z',
    source: 'facebook',
    source_url: 'https://www.facebook.com/groups/938644249820363/posts/3077055422645891/',
    transaction_type: 'rent',
    property_type: null,
    city: 'Tel Aviv',
    neighborhood: null,
    street: 'דפנה',
    phone: null,
    price: null,
    rooms: 4,
    surface_m2: null,
    floor: null,
    parking: null, elevator: null, balcony: null, mamad: null, garden: null, pool: null,
    gym: null, sea_view: null, terrace: null, pet_friendly: null, furnished: null,
  })
  assert.deepEqual(result.extras, {
    fb_post_id: '3077055422645891',
    fb_group_id: '938644249820363',
    author_name: 'Omer Paz',
    likes_count: 0,
    comments_count: 0,
    phones: [],
    total_floors: null,
    protected_space_type: null,
    post_intent: 'offer',
  })
  assert.deepEqual(result.photoUrls, [])
  // Price is optional for Facebook, so the real sample (no price stated) has nothing missing.
  assert.deepEqual(result.missingRequired, [])
  assert.equal(result.property.price, null)
  assert.ok(Object.values(result.derived.features).every((s) => s === 'unknown'), 'no amenity invented')
})

test('rent with full details', () => {
  const { property, derived, extras } = map('rent_full')
  assert.equal(property.source_url, 'https://www.facebook.com/groups/111111111111111/posts/222222222222222/')
  assert.equal(property.transaction_type, 'rent')
  assert.equal(property.property_type, 'apartment')
  assert.equal(property.city, 'Tel Aviv')
  assert.equal(property.neighborhood, 'Florentin')
  assert.equal(property.street, 'ויטל 5')
  assert.equal(property.rooms, 3.5)
  assert.equal(property.surface_m2, 75)
  assert.equal(property.floor, 2)
  assert.equal(extras.total_floors, 4)
  assert.equal(property.price, 7800)
  assert.equal(property.phone, '0541234567')
  // "מרפסת שמש" is a balcony in the shared dictionary, not a roof terrace.
  for (const key of ['elevator', 'balcony', 'mamad', 'parking', 'furnished'] as const) {
    assert.equal(derived.features[key], 'yes', key)
  }
  assert.equal(derived.protectedSpaceType, 'mamad')
  assert.equal(derived.features.petFriendly, 'unknown')
  assert.deepEqual(derived.entryDate, { kind: 'immediate' })
})

test('sale with explicit negatives and a price in millions', () => {
  const { property, derived } = map('sale_negatives')
  assert.equal(property.transaction_type, 'sale')
  assert.equal(property.street, 'ארלוזורוב 120')
  assert.equal(property.city, 'Tel Aviv')
  assert.equal(property.rooms, 4)
  assert.equal(property.surface_m2, 110)
  assert.equal(property.floor, 3)
  assert.equal(property.price, 4950000)
  assert.equal(property.phone, '0529876543')
  assert.equal(derived.features.parking, 'no')
  assert.equal(derived.features.elevator, 'no')
})

test('English text, ground floor, K price, miklat with negated mamad', () => {
  const { property, derived } = map('english_miklat')
  assert.equal(property.transaction_type, 'rent')
  assert.equal(property.city, 'Tel Aviv')
  assert.equal(property.rooms, 2)
  assert.equal(property.floor, 0)
  assert.equal(property.surface_m2, 45)
  assert.equal(property.price, 5200)
  assert.equal(derived.features.mamad, 'yes')
  assert.equal(derived.protectedSpaceType, 'miklat')
  assert.equal(derived.features.balcony, 'no')
  assert.equal(derived.features.petFriendly, 'no')
})

test('garden apartment: garden size is not the surface, pets yes, mamak', () => {
  const { property, derived } = map('garden_pets_mamak')
  assert.equal(property.property_type, 'garden apartment')
  assert.equal(property.neighborhood, 'Jaffa')
  assert.equal(property.city, null, 'neighborhood never invents the city')
  assert.equal(property.surface_m2, null)
  assert.equal(property.price, 9500)
  assert.equal(derived.features.garden, 'yes')
  assert.equal(derived.features.petFriendly, 'yes')
  assert.equal(derived.protectedSpaceType, 'mamak')
})

test('phone numbers are never read as prices', () => {
  const { property, extras } = map('phone_not_price')
  assert.equal(property.transaction_type, 'rent')
  assert.equal(property.price, 6000)
  assert.equal(property.phone, '0501234567')
  assert.deepEqual(extras.phones, ['0501234567', '036123456'])
  const phoneOnly = mapFacebookItem({ ...synthetic.phone_not_price, text: 'להשכרה בתל אביב 054-123-4567' })
  assert.equal(phoneOnly.property.price, null)
})

test('seeker posts are flagged and a room range is not a room count', () => {
  const { property, extras } = map('seeker')
  assert.equal(extras.post_intent, 'seeking')
  assert.equal(property.rooms, null)
})

test('unclear text stays unknown everywhere', () => {
  const { property, derived, extras } = map('unclear')
  assert.equal(property.transaction_type, null)
  assert.equal(property.city, null)
  assert.equal(property.price, null)
  assert.equal(property.rooms, null)
  assert.equal(extras.post_intent, 'unknown')
  assert.ok(Object.values(derived.features).every((s) => s === 'unknown'))
})

test('city goes through existing normalization', () => {
  assert.equal(mapFacebookItem(sample).property.city, normalizeCity('תל אביב'))
})

test('dashboard read path re-derives exactly what the mapper derived', () => {
  for (const item of [sample, ...Object.values(synthetic)]) {
    const { property, derived } = mapFacebookItem(item)
    const read = readPathDerive(property)
    assert.deepEqual(read.features, derived.features)
    assert.equal(read.protectedSpaceType, derived.protectedSpaceType)
  }
})

test('original text is preserved byte-for-byte', () => {
  for (const item of [sample, ...Object.values(synthetic)]) {
    assert.equal(mapFacebookItem(item).property.description, item.text)
  }
})
