/**
 * Facebook listing presentation tests: runs stored rows through the real read path (rowToListing)
 * and the display helpers the card and detail sheet use. Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/facebook-presentation.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rowToListing, type PropertyRow } from '../../lib/supabase.ts'
import { amenityDisplayLabel } from '../../lib/listings.ts'
import { displayPhone, displayPrice, phoneHref, PRICE_NOT_STATED } from '../../lib/listing-display.ts'

function fbRow(overrides: Partial<PropertyRow>): PropertyRow {
  return {
    id: 'fb-1',
    created_at: '2026-07-01T10:00:00Z',
    title: null,
    transaction_type: 'rent',
    city: null,
    neighborhood: null,
    street: null,
    price: null,
    rooms: null,
    surface_m2: null,
    floor: null,
    phone: null,
    source: 'facebook',
    source_url: 'https://www.facebook.com/groups/938644249820363/posts/1',
    published_at: '2026-07-01T09:00:00Z',
    property_type: null,
    parking: null,
    mamad: null,
    balcony: null,
    elevator: null,
    furnished: null,
    terrace: null,
    garden: null,
    pool: null,
    gym: null,
    sea_view: null,
    pet_friendly: null,
    description: null,
    available_from: null,
    ...overrides,
  }
}

const labels = (l: ReturnType<typeof rowToListing>) => l.amenities.map((k) => amenityDisplayLabel(l, k))

test('Facebook rental with phone keeps description, phone, link and price', () => {
  const text = 'להשכרה דירת 3 חדרים ברחוב דיזנגוף 150, 6500 ש"ח. לפרטים 054-1234567'
  const l = rowToListing(fbRow({ description: text, price: 6500, rooms: 3, street: 'דיזנגוף 150', phone: '0541234567' }))
  assert.equal(l.description, text)
  assert.equal(l.dealType, 'rent')
  assert.equal(displayPrice(l), '₪6,500')
  assert.equal(displayPhone(l.phone), '054-123-4567')
  assert.equal(phoneHref(l.phone), 'tel:+972541234567')
  assert.equal(l.url, 'https://www.facebook.com/groups/938644249820363/posts/1')
  assert.equal(l.city, 'Tel Aviv')
  assert.equal(l.publishedAt, '2026-07-01T09:00:00Z')
})

test('Facebook sale is a sale with a normal price', () => {
  const l = rowToListing(fbRow({ transaction_type: 'sale', price: 3200000, description: 'למכירה 4 חדרים בפלורנטין' }))
  assert.equal(l.dealType, 'sale')
  assert.equal(displayPrice(l), '₪3,200,000')
})

test('price-less post shows "Price not stated", never ₪0', () => {
  for (const price of [null, 0, '0']) {
    const l = rowToListing(fbRow({ price, description: 'דירה מהממת להשכרה, מחיר בפרטי' }))
    assert.equal(displayPrice(l), PRICE_NOT_STATED)
    assert.ok(!displayPrice(l).includes('₪0'))
  }
})

test('no phone stored means no phone shown (never invented)', () => {
  const l = rowToListing(fbRow({ description: 'דירה להשכרה, פרטים בפרטי' }))
  assert.equal(l.phone, '')
})

test('post with mamad shows a Mamad badge', () => {
  const l = rowToListing(fbRow({ description: 'דירת 3 חדרים עם ממ"ד ומרפסת' }))
  assert.equal(l.features.mamad, 'yes')
  assert.equal(l.protectedSpaceType, 'mamad')
  assert.ok(labels(l).includes('Mamad'))
})

test('post with miklat shows Miklat, never Mamad', () => {
  const l = rowToListing(fbRow({ description: 'יש מקלט בבניין' }))
  assert.equal(l.protectedSpaceType, 'miklat')
  assert.ok(labels(l).includes('Miklat'))
  assert.ok(!labels(l).includes('Mamad'))
})

test('post with parking shows a parking badge', () => {
  const l = rowToListing(fbRow({ description: 'דירה עם חניה בטאבו' }))
  assert.equal(l.features.parking, 'yes')
  assert.ok(l.amenities.includes('parking'))
})

test('post with no amenities shows no badges', () => {
  const l = rowToListing(fbRow({ description: 'דירת 2 חדרים להשכרה' }))
  assert.deepEqual(l.amenities, [])
})

test('unknown and explicit-no amenities never become badges', () => {
  const l = rowToListing(fbRow({ description: 'אין חניה, אין מעלית. אולי אפשר עם חיות, צריך לבדוק' }))
  assert.notEqual(l.features.parking, 'yes')
  assert.notEqual(l.features.elevator, 'yes')
  assert.ok(!l.amenities.includes('parking'))
  assert.ok(!l.amenities.includes('elevator'))
  for (const key of l.amenities) assert.equal(l.features[key], 'yes')
})

test('raw Hebrew subdivision is never the main neighborhood', () => {
  const l = rowToListing(fbRow({ neighborhood: 'תת-רובע לא ידוע', description: 'דירה להשכרה' }))
  assert.ok(!/[\u0590-\u05FF]/.test(l.neighborhood))
})
