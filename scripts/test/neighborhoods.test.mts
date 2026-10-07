/**
 * Canonical Tel Aviv neighborhood resolver tests. Offline: uses the municipal GIS snapshot in lib/geo/data.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/neighborhoods.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CANONICAL_NEIGHBORHOODS, zoneFromSourceName } from '../../lib/geo/canonical-neighborhoods.ts'
import { findAddressesInText, resolveNeighborhood } from '../../lib/geo/resolve-neighborhood.ts'

const zone = (input: Parameters<typeof resolveNeighborhood>[0]) => resolveNeighborhood(input).neighborhood

test('Shabazi with an exact address resolves geographically to Neve Tzedek', () => {
  const r = resolveNeighborhood({ street: 'שבזי 42' })
  assert.equal(r.neighborhood, 'Neve Tzedek')
  assert.equal(r.method, 'address')
})

test('Shabazi in a Facebook post body ("שבזי 42, תל אביב") resolves to Neve Tzedek', () => {
  const r = resolveNeighborhood({ text: 'להשכרה דירת 2 חדרים ברחוב שבזי 42, תל אביב. 6500 ש"ח' })
  assert.equal(r.neighborhood, 'Neve Tzedek')
  assert.equal(r.method, 'address')
})

test('Shabazi without a house number: the whole street lies in Neve Tzedek', () => {
  const r = resolveNeighborhood({ street: 'שבזי' })
  assert.equal(r.neighborhood, 'Neve Tzedek')
  assert.equal(r.method, 'street')
})

test('Arlozorov without a number is ambiguous and stays unknown', () => {
  assert.equal(zone({ street: 'ארלוזורוב' }), null)
  assert.equal(zone({ sourceNeighborhood: 'ארלוזורוב' }), null)
  assert.equal(zone({ text: 'דירה מהממת ברחוב ארלוזורוב' }), null)
})

test('Arlozorov with a precise house number uses the geographic result', () => {
  assert.equal(zone({ street: 'ארלוזורוב 15' }), 'Old North')
  assert.equal(zone({ street: 'ארלוזורוב 120' }), 'New North')
  assert.equal(zone({ text: 'דירה ברחוב ארלוזורוב 15 תל אביב' }), 'Old North')
})

test('Park Tzameret is its own zone', () => {
  assert.ok(CANONICAL_NEIGHBORHOODS.includes('Park Tzameret'))
  assert.equal(zoneFromSourceName('פארק צמרת'), 'Park Tzameret')
  assert.equal(zoneFromSourceName('Park Tzameret'), 'Park Tzameret')
})

test('Old North Hebrew subdivisions (Yad2 + Madlan) all merge', () => {
  for (const raw of [
    'הצפון הישן',
    'הצפון הישן - החלק הצפוני',
    'הצפון הישן - החלק הדרומי',
    'הצפון הישן החלק הדרום מזרחי',
    'הצפון הישן החלק הדרום מערבי',
    'הצפון הישן החלק המרכזי',
  ]) {
    assert.equal(zoneFromSourceName(raw), 'Old North', raw)
  }
})

test('New North Hebrew subdivisions and Kikar HaMedina merge', () => {
  for (const raw of [
    'הצפון החדש -החלק הצפוני',
    'הצפון החדש - החלק הדרומי',
    'הצפון החדש החלק הדרומי',
    'הצפון החדש - כיכר המדינה',
    'הצפון החדש סביבת כיכר המדינה',
    'כיכר המדינה',
    'Kikar HaMedina',
  ]) {
    assert.equal(zoneFromSourceName(raw), 'New North', raw)
  }
})

test('Lev HaIr subdivisions collapse into one Lev HaIr', () => {
  for (const raw of ['לב העיר', 'לב העיר צפון', 'לב העיר - דרום', 'לב תל אביב', 'לב תל אביב החלק המערבי', 'Lev HaIr North', 'Lev HaIr West']) {
    assert.equal(zoneFromSourceName(raw), 'Lev HaIr', raw)
  }
})

test('Neve Tzedek, Florentin, Kerem HaTeimanim, Bavli source names', () => {
  assert.equal(zoneFromSourceName('נווה צדק'), 'Neve Tzedek')
  assert.equal(zoneFromSourceName('נוה צדק'), 'Neve Tzedek')
  assert.equal(zoneFromSourceName('פלורנטין'), 'Florentin')
  assert.equal(zoneFromSourceName('כרם התימנים'), 'Kerem HaTeimanim')
  assert.equal(zoneFromSourceName('בבלי'), 'Bavli')
  assert.equal(zoneFromSourceName('שיכון בבלי'), 'Bavli')
})

test('addresses in those zones resolve geographically', () => {
  assert.equal(zone({ street: 'פלורנטין 10' }), 'Florentin')
  assert.equal(zone({ street: 'הכרמל 21' }), 'Kerem HaTeimanim')
  // Two municipal "הכרמל" streets disagree on even #20 (Lev HaIr vs Kerem HaTeimanim) → refused.
  assert.equal(zone({ street: 'הכרמל 20' }), null)
  assert.equal(zone({ street: 'רוטשילד 50' }), 'Lev HaIr')
  assert.equal(zone({ street: 'נחמני 13, לב תל אביב' }), 'Lev HaIr')
})

test('geography beats a conflicting source name', () => {
  assert.equal(zone({ street: 'שבזי 42', sourceNeighborhood: 'פלורנטין' }), 'Neve Tzedek')
})

test('an address outside every zone stays unknown instead of using a weaker signal', () => {
  const r = resolveNeighborhood({ street: 'ארלוזורוב 15', sourceNeighborhood: 'פלורנטין' })
  assert.equal(r.method, 'address')
})

test('coordinates are the strongest signal', () => {
  const shabazi = resolveNeighborhood({ street: 'שבזי 42' })
  assert.equal(shabazi.municipal, 'נוה צדק')
  // Suzanne Dellal Center, Neve Tzedek
  assert.equal(zone({ latitude: 32.0606, longitude: 34.7656, street: 'ארלוזורוב 15' }), 'Neve Tzedek')
})

test('refused and unknown source names are never guessed', () => {
  for (const raw of ['נחלת בנימין', 'גימל החדשה', 'תל ברוך', 'כפר שלם מערב', 'Somewhere', '', null]) {
    assert.equal(zoneFromSourceName(raw), null, String(raw))
  }
})

test('expanded zones resolve from source names', () => {
  const cases: [string, string][] = [
    ['רמת אביב החדשה', 'Ramat Aviv HaHadasha'],
    ['נופי ים', 'Ramat Aviv HaHadasha'],
    ['למד', 'Ramat Aviv HaHadasha'],
    ['נווה אביבים', 'Neve Avivim'],
    ["נאות אפקה א'", 'Neot Afeka'],
    ['המשתלה', 'HaMashtela'],
    ['הרכבת', 'Montefiore'],
    ['קרית הממשלה', 'Sarona'],
    ['שרונה', 'Sarona'],
    ['נחלת יצחק', 'Nahalat Yitzhak'],
    ['רמת הטייסים', 'Ramat HaTayasim'],
    ['נווה צה"ל', 'HaTikva'],
    ['נווה חן', 'Neve Hen'],
  ]
  for (const [raw, expected] of cases) assert.equal(zoneFromSourceName(raw), expected, raw)
  assert.equal(CANONICAL_NEIGHBORHOODS.length, 25)
})

test('dropdown keeps the single big zones and no directional subdivisions', () => {
  for (const z of ['Lev HaIr', 'Old North', 'New North', 'Park Tzameret']) assert.ok(CANONICAL_NEIGHBORHOODS.includes(z as never))
  assert.ok(CANONICAL_NEIGHBORHOODS.every((z) => !/North$|West$|South$|East$/.test(z) || z === 'Old North' || z === 'New North'))
  assert.ok(CANONICAL_NEIGHBORHOODS.every((z) => !/[\u0590-\u05FF]/.test(z)))
})

test('ambiguous words are not read from free text', () => {
  assert.equal(zone({ text: 'דירה ברחוב מונטיפיורי, מרפסת' }), null)
  assert.equal(zone({ text: 'מחכה בתקווה לשוכרים, ליד הרכבת' }), null)
  assert.equal(zone({ text: 'דירה מקסימה בנווה אביבים' }), 'Neve Avivim')
})

test('explicit neighborhood text is used, "near X" is not', () => {
  assert.equal(zone({ text: 'דירה מקסימה בפלורנטין, 3 חדרים' }), 'Florentin')
  assert.equal(zone({ text: 'דירה 5 דקות הליכה מנווה צדק' }), null)
  assert.equal(zone({ text: 'דירה בתל אביב יפו' }), null)
  assert.equal(zone({ text: 'בין פלורנטין לנווה צדק' }), null)
})

test('numbers that are sizes or prices are not house numbers', () => {
  assert.deepEqual(findAddressesInText('דירת 3 חדרים, 70 מ"ר, קומה 2'), [])
})
