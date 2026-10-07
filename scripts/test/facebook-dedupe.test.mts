/**
 * Facebook parsing + read-time dedupe, against real production posts (fixtures/facebook-production-posts.json)
 * run through the real read path (rowToListing → dedupeFacebookListings). Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/facebook-dedupe.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { rowToListing, type PropertyRow } from '../../lib/supabase.ts'
import { dedupeFacebookListings } from '../../lib/facebook-dedupe.ts'
import { mapFacebookItem } from '../../lib/facebook-mapper.ts'

type Fixture = Partial<PropertyRow> & { id: number; description: string; source_url: string }
const posts: Fixture[] = JSON.parse(readFileSync(new URL('./fixtures/facebook-production-posts.json', import.meta.url), 'utf8'))

function row(overrides: Partial<PropertyRow>): PropertyRow {
  return {
    id: 'fb',
    created_at: '2026-07-01T10:00:00Z',
    title: null,
    transaction_type: null,
    city: null,
    neighborhood: null,
    street: null,
    price: null,
    rooms: null,
    surface_m2: null,
    floor: null,
    phone: null,
    source: 'facebook',
    source_url: 'https://www.facebook.com/groups/1/posts/1',
    published_at: '2026-07-01T09:00:00Z',
    property_type: null,
    description: null,
    ...overrides,
  } as PropertyRow
}

function prod(id: number) {
  const p = posts.find((x) => x.id === id)
  assert.ok(p, `fixture ${id}`)
  const { id: _id, ...rest } = p
  return rowToListing(row({ ...rest, id: String(id) } as Partial<PropertyRow>))
}

const fromText = (text: string, id = 'synthetic') =>
  rowToListing(row({ id, description: text, source_url: `https://www.facebook.com/groups/1/posts/${id}` }))

// ---------- dedupe ----------

test('same apartment reposted in several groups is shown once, other post URLs kept', () => {
  const reposts = [653, 655, 690].map(prod)
  const out = dedupeFacebookListings(reposts)
  assert.equal(out.length, 1)
  assert.equal(out[0].alsoPostedAt?.length, 2)
  assert.equal(new Set([out[0].url, ...(out[0].alsoPostedAt ?? [])]).size, 3)
})

test('same post imported twice collapses to one', () => {
  const a = prod(781)
  const b = { ...a, id: 'copy' }
  assert.equal(dedupeFacebookListings([a, b]).length, 1)
})

test('same street + same price alone never merges', () => {
  const a = fromText('להשכרה ברחוב דיזנגוף דירת 3 חדרים, 8,000 ₪, מעלית. 050-1111111', 'a')
  const b = fromText('דירה מהממת ברחוב דיזנגוף 2 חדרים משופצת 8,000 ₪ לחודש, 052-2222222', 'b')
  assert.equal(dedupeFacebookListings([a, b]).length, 2)
})

test('identical text but conflicting price is not merged', () => {
  const a = fromText('להשכרה ברחוב הרצל 3 חדרים 70 מ"ר מחיר 7,000 ₪ 050-1234567', 'a')
  const b = fromText('להשכרה ברחוב הרצל 3 חדרים 70 מ"ר מחיר 7,900 ₪ 050-1234567', 'b')
  assert.equal(dedupeFacebookListings([a, b]).length, 2)
})

test('Yad2 / Madlan listings pass through untouched', () => {
  const fb = prod(781)
  const yad2 = { ...fb, id: 'y', source: 'yad2' as const }
  const out = dedupeFacebookListings([fb, { ...fb, id: 'copy' }, yad2])
  assert.deepEqual(out.map((l) => l.source).sort(), ['facebook', 'yad2'])
})

// ---------- street / neighborhood ----------

test('street + number resolves a canonical neighborhood', () => {
  const l = prod(781)
  assert.equal(l.street, 'דיזנגוף 214')
  assert.ok(l.neighborhood)
})

test('two-word street without number is kept whole', () => {
  assert.equal(prod(785).street, 'יעקב מוזר')
})

test('street name stops at "ליד" / punctuation / quotes', () => {
  assert.equal(prod(652).street, 'מנחם')
  assert.equal(prod(670).street, 'הכובשים')
  assert.equal(prod(653).street, 'סימטת הש"ך')
})

test('"ברחוב שקט" is a description, not a street', () => {
  assert.notEqual(prod(682).street, 'שקט')
  assert.equal(fromText('דירת 3 חדרים ברחוב שקט וירוק, 6,000 ₪').street, '')
})

test('ambiguous long street without number leaves neighborhood unknown', () => {
  const l = fromText('להשכרה דירת 3 חדרים ברחוב אבן גבירול, 8,500 ₪')
  assert.equal(l.street, 'אבן גבירול')
  assert.equal(l.neighborhood, '')
})

test('known street followed by a number without "רחוב" marker', () => {
  assert.equal(fromText('דירת 2 חדרים בדיזנגוף 214, קומה 3, 7,000 ₪').street, 'דיזנגוף 214')
  assert.equal(fromText('דירה ב-אבן גבירול 17, 3 חדרים').street, 'אבן גבירול 17')
})

test('house number is not taken from a room count', () => {
  assert.equal(fromText('ברחוב הרצל 3 חדרים 6,000 ₪').street, 'הרצל')
})

// ---------- rooms ----------

test('Hebrew room counts', () => {
  assert.equal(prod(781).rooms, 3)
  assert.equal(fromText('דירת 3.5 חדרים בקומה 2, 7,500 ₪').rooms, 3.5)
  assert.equal(fromText("3 חד' משופצת").rooms, 3)
  assert.equal(fromText('להשכרה דירת חדר מעוצבת 30 מ"ר').rooms, 1)
  assert.equal(prod(670).rooms, 1)
})

test('English room counts', () => {
  assert.equal(fromText('Lovely 2-room apartment, 6,000 NIS').rooms, 2)
  assert.equal(fromText('3.5 rooms, elevator').rooms, 3.5)
})

test('missing / ambiguous rooms stay null (roommates, floor, room in a shared flat)', () => {
  assert.equal(fromText('חדר בדירת שותפים, 3 שותפים, קומה 4, 3,200 ₪').known.rooms, false)
  assert.equal(fromText('דירה מהממת להשכרה, קומה 2, 6,000 ₪').known.rooms, false)
})

// ---------- price / deal type / phone ----------

test('Facebook sale and rental', () => {
  const sale = prod(713)
  assert.equal(sale.dealType, 'sale')
  assert.equal(sale.price, 6_500_000)
  const rent = prod(781)
  assert.equal(rent.dealType, 'rent')
  assert.equal(rent.price, 12_000)
})

test('fees and per-m² prices are not taken as the price', () => {
  const p = (t: string) => mapFacebookItem({ text: t }).property.price
  assert.equal(p('ארנונה כ635 ₪ לחודשיים וועד 400 ₪ לחודש שכר דירה: 10,500'), 10_500)
  assert.equal(p('ארנונה כ 500 ש״ח | ועד בית 150 ש״ח מחיר 8,700 לחודש'), 8_700)
  assert.notEqual(p('מחיר טוב מאוד: 48,000 ש"ח למ"ר 4 חדרים'), 48_000)
  assert.notEqual(prod(656).price, 635)
  assert.equal(prod(705).price, 8_700)
})

test('phone present / absent', () => {
  assert.match(prod(781).phone, /^05\d{8}$/)
  assert.equal(prod(718).phone, '')
})

function mapped(text: string) {
  return mapFacebookItem({ url: 'https://www.facebook.com/groups/1/posts/2', text } as any).property as any
}

test('official street + house number followed by a floor, no comma', () => {
  for (const [text, street, floor] of [
    ['דיזנגוף 214 קומה 3', 'דיזנגוף 214', 3],
    ['בדיזנגוף 214 קומה 3', 'דיזנגוף 214', 3],
    ['אבן גבירול 17 קומה 2', 'אבן גבירול 17', 2],
    ['ב-אבן גבירול 17 קומה 2', 'אבן גבירול 17', 2],
    ['ברחוב דיזנגוף 214 קומה 3', 'דיזנגוף 214', 3],
  ] as const) {
    const p = mapped(text)
    assert.equal(p.street, street, text)
    assert.equal(p.floor, floor, text)
  }
  const full = mapped('להשכרה דירת 3 חדרים בדיזנגוף 214 קומה 3 מחיר 7,500 ₪')
  assert.deepEqual([full.street, full.floor, full.price, full.rooms, full.transaction_type], ['דיזנגוף 214', 3, 7_500, 3, 'rent'])
})

test('floor phrase does not turn a number after a non-street into a house number', () => {
  assert.equal(mapped('דירת 3 קומה 2 להשכרה').street, null)
})

test('price formats from real production posts', () => {
  // post 719
  const a = mapped('מתיווך למכירה בית דו משפחתי ברחוב שקט שבשכונת יד אליהו תל אביב שטח מגרש 282 מר מחיר חדש 5.430.000 שח')
  assert.deepEqual([a.price, a.transaction_type], [5_430_000, 'sale'])
  // post 787
  assert.equal(mapped('למכירה דירה צפון יד אליהו קרקע 86 מטר פינתית מחיר 3.150.000 יפית').price, 3_150_000)
  // post 657: million abbreviation; "100 מ' מהדירה" is meters, not money
  const c = mapped('דירה למכירה בלב תל אביב דירת 3 חדרים, 66 מ"ר קומה 2.5 מקלט ציבורי 100 מ\' מהדירה מחיר מבוקש: 3.79 מ׳ ש"ח')
  assert.deepEqual([c.price, c.rooms, c.transaction_type], [3_790_000, 3, 'sale'])
  // post 709
  const d = mapped('For Rent | Sarona Towers – Tel Aviv 100 sqm 4 rooms 💰 ₪13.900 per month')
  assert.deepEqual([d.price, d.rooms, d.transaction_type], [13_900, 4, 'rent'])
})

test('ambiguous or non-rent amounts stay out of price', () => {
  assert.equal(mapped('למכירה דירת 5 חדרים 148.5 מ"ר מחיר 5.85 תיווך').price, null) // post 695: no unit
  assert.equal(mapped('דירה להשכרה ארנונה 1.200 ש"ח').price, null)
  assert.equal(mapped('דירה להשכרה ועד בית 250 ₪').price, null)
  assert.equal(mapped('למכירה 48.000 ש"ח למ"ר').price, null)
  assert.equal(mapped('מקלט 100 מ\' מהדירה').price, null)
})

test('amenities still parsed (regression)', () => {
  const l = fromText('להשכרה ברחוב הרצל 3 חדרים, מעלית, חניה, ממ"ד, 7,000 ₪ 050-1234567')
  assert.ok(l.amenities.includes('elevator'))
  assert.ok(l.amenities.includes('parking'))
})
