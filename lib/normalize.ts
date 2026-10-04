import type { AmenityKey, DealType, Source } from './listings'

/**
 * Shared alias tables for Yad2 / Madlan / Facebook data.
 * Each entry maps a canonical value to the raw variants that should be treated as equal.
 * Matching ignores case, spacing, hyphens (incl. Hebrew maqaf), quotes/geresh and dots,
 * so "Tel-Aviv", "tel aviv  yafo" and "ת״א" do not need separate entries.
 */
type AliasTable<T extends string = string> = Record<T, readonly string[]>

export const CITY_ALIASES: AliasTable = {
  'Tel Aviv': [
    'Tel Aviv',
    'Tel Aviv-Yafo',
    'Tel Aviv Yafo',
    'Tel Aviv-Jaffa',
    'Tel Aviv Jaffa',
    'TLV',
    'תל אביב',
    'תל אביב יפו',
    'תל-אביב',
    'תל אביב-יפו',
    'ת"א',
  ],
}

// Only exact equivalents; Yad2 sub-areas (e.g. "הצפון הישן - החלק הדרומי") stay as-is.
export const NEIGHBORHOOD_ALIASES: AliasTable = {
  Florentin: ['Florentin', 'פלורנטין'],
  'Neve Tzedek': ['Neve Tzedek', 'Neve Tsedek', 'נווה צדק'],
  'Old North': ['Old North', 'הצפון הישן'],
  'New North': ['New North', 'הצפון החדש'],
  'Kerem HaTeimanim': ['Kerem HaTeimanim', 'Kerem Hateimanim', 'כרם התימנים'],
  Jaffa: ['Jaffa', 'Yafo', 'יפו'],
  'Old Jaffa': ['Old Jaffa', 'יפו העתיקה'],
  Bavli: ['Bavli', 'בבלי'],
}

export const PROPERTY_TYPE_ALIASES: AliasTable = {
  apartment: ['apartment', 'flat', 'דירה'],
  'garden apartment': ['garden apartment', 'דירת גן'],
  penthouse: ['penthouse', 'פנטהאוז', 'פנטהאוס', 'דירת גג'],
  duplex: ['duplex', 'דופלקס'],
  studio: ['studio', 'loft', 'סטודיו', 'לופט', 'סטודיו/לופט'],
  house: ['house', 'private house', 'cottage', 'villa', 'בית פרטי', "קוטג'", 'וילה'],
}

export const AMENITY_ALIASES: AliasTable<AmenityKey> = {
  parking: ['parking', 'חניה', 'חנייה'],
  mamad: ['mamad', 'safe room', 'ממ"ד', 'ממד'],
  balcony: ['balcony', 'מרפסת'],
  elevator: ['elevator', 'lift', 'מעלית'],
  furnished: ['furnished', 'מרוהטת', 'ריהוט'],
  terrace: ['terrace', 'מרפסת גג', 'מרפסת שמש'],
  garden: ['garden', 'גינה'],
  pool: ['pool', 'swimming pool', 'בריכה'],
  gym: ['gym', 'חדר כושר'],
  seaView: ['sea view', 'נוף לים'],
  petFriendly: ['pet friendly', 'pets allowed', 'בעלי חיים', 'חיות מחמד'],
}

export const DEAL_TYPE_ALIASES: AliasTable<DealType> = {
  rent: ['rent', 'rental', 'for rent', 'lease', 'להשכרה', 'השכרה', 'שכירות'],
  sale: ['sale', 'sell', 'for sale', 'buy', 'למכירה', 'מכירה', 'קנייה'],
}

export const SOURCE_ALIASES: AliasTable<Exclude<Source, 'other'>> = {
  facebook: ['facebook', 'fb', 'פייסבוק'],
  yad2: ['yad2', 'yad 2', 'יד2', 'יד 2'],
  madlan: ['madlan', 'מדלן'],
}

export function aliasKey(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, (c) => (c === '\u05BE' ? ' ' : '')) // niqqud/cantillation; maqaf → space
    .replace(/["'`\u05F3\u05F4\u2018\u2019\u201C\u201D.,/\\()\-\u2010-\u2015_]/g, ' ')
    .replace(/\s+/g, '')
}

function buildLookup<T extends string>(table: AliasTable<T>) {
  const lookup = new Map<string, T>()
  for (const canonical of Object.keys(table) as T[]) {
    lookup.set(aliasKey(canonical), canonical)
    for (const alias of table[canonical]) lookup.set(aliasKey(alias), canonical)
  }
  return lookup
}

const cityLookup = buildLookup(CITY_ALIASES)
const neighborhoodLookup = buildLookup(NEIGHBORHOOD_ALIASES)
const propertyTypeLookup = buildLookup(PROPERTY_TYPE_ALIASES)
const amenityLookup = buildLookup(AMENITY_ALIASES)
const dealTypeLookup = buildLookup(DEAL_TYPE_ALIASES)
const sourceLookup = buildLookup(SOURCE_ALIASES)

/** Returns the canonical value for known aliases, otherwise the trimmed raw value. */
function canonical(lookup: Map<string, string>, value: string | null | undefined) {
  const raw = (value ?? '').trim()
  return lookup.get(aliasKey(raw)) ?? raw
}

export const normalizeCity = (value: string | null | undefined) => canonical(cityLookup, value)
export const normalizeNeighborhood = (value: string | null | undefined) => canonical(neighborhoodLookup, value)
export const normalizePropertyType = (value: string | null | undefined) => canonical(propertyTypeLookup, value)

export function normalizeAmenity(value: string | null | undefined): AmenityKey | null {
  return amenityLookup.get(aliasKey(value)) ?? null
}

/** Unknown values keep the previous default of "sale". */
export function normalizeDealType(value: string | null | undefined): DealType {
  const exact = dealTypeLookup.get(aliasKey(value))
  if (exact) return exact
  const key = aliasKey(value)
  return key.includes('rent') || key.includes('השכר') || key.includes('שכירות') ? 'rent' : 'sale'
}

export function normalizeSource(value: string | null | undefined): Source {
  const key = aliasKey(value)
  const exact = sourceLookup.get(key)
  if (exact) return exact
  for (const [needle, source] of sourceLookup) if (key.includes(needle)) return source
  return 'other'
}

/** Compares two values after normalizing both sides with the given normalizer. */
export function sameNormalized(
  normalize: (value: string | null | undefined) => string,
  a: string | null | undefined,
  b: string | null | undefined,
) {
  return aliasKey(normalize(a)) === aliasKey(normalize(b))
}
