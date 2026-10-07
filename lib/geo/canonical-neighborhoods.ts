/**
 * The one dashboard neighborhood system for Tel Aviv.
 *
 * Zones are defined as groups of OFFICIAL municipal neighborhoods (Tel Aviv GIS layer 511, `ms_shchuna`),
 * so geography decides membership. To adjust a zone, move municipal numbers between entries.
 * Municipal neighborhoods not listed here (e.g. Tel Baruch, Montefiore, Neve Avivim) resolve to no zone.
 *
 * This module is tiny and safe to import from client components; the geography data lives in ./resolve-neighborhood.
 */

export const CANONICAL_NEIGHBORHOODS = [
  'Old North',
  'New North',
  'Park Tzameret',
  'Bavli',
  'Lev HaIr',
  'Neve Tzedek',
  'Kerem HaTeimanim',
  'Florentin',
  'Jaffa',
  'Old Jaffa',
  'Shapira',
  'Yad Eliyahu',
  'Ramat Aviv',
  'Kiryat Shalom',
  'Neve Shaanan',
] as const

export type CanonicalNeighborhood = (typeof CANONICAL_NEIGHBORHOODS)[number]

export const CANONICAL_CITY = 'Tel Aviv'

/** Canonical zone → official municipal neighborhood numbers it contains. */
export const ZONE_MUNICIPAL_NUMBERS: Record<CanonicalNeighborhood, readonly number[]> = {
  'Old North': [30, 31], // הצפון הישן – החלק הצפוני / הדרומי
  'New North': [33, 34, 35], // הצפון החדש – צפוני / סביבת ככר המדינה / דרומי
  'Park Tzameret': [36], // צמרות איילון (separate municipal polygon from the New North)
  Bavli: [32],
  'Lev HaIr': [37], // לב תל-אביב
  'Neve Tzedek': [39],
  'Kerem HaTeimanim': [38],
  Florentin: [52],
  // צפון יפו, גבעת הרצל/אזור המלאכה, עג'מי וגבעת עליה, צהלון ושיכוני חסכון, יפו ג' ונוה גולן, דקר, יפו ד'
  Jaffa: [42, 43, 45, 46, 47, 48, 49],
  'Old Jaffa': [44], // יפו העתיקה, נמל יפו
  Shapira: [54],
  'Yad Eliyahu': [62],
  'Ramat Aviv': [10, 7], // רמת-אביב, רמת אביב ג'
  'Kiryat Shalom': [56],
  'Neve Shaanan': [53],
}

const zoneByMunicipal = new Map<number, CanonicalNeighborhood>()
for (const zone of CANONICAL_NEIGHBORHOODS) for (const ms of ZONE_MUNICIPAL_NUMBERS[zone]) zoneByMunicipal.set(ms, zone)

export function zoneForMunicipalNeighborhood(ms: number): CanonicalNeighborhood | null {
  return zoneByMunicipal.get(ms) ?? null
}

/** Same folding as `aliasKey` in lib/normalize (kept local so this module has no dependencies). */
export function geoKey(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, (c) => (c === '\u05BE' ? ' ' : ''))
    .replace(/["'`\u05F3\u05F4\u2018\u2019\u201C\u201D.,/\\()\-\u2010-\u2015_]/g, ' ')
    .replace(/\s+/g, '')
    .replace(/וו/g, 'ו') // נווה/נוה, קריית/קרית spelling variants
    .replace(/יי/g, 'י')
}

/**
 * Source neighborhood names (Yad2, Madlan, Facebook, municipal) → zone.
 * Exact names only, except the families below which are matched by prefix.
 */
const SOURCE_ALIASES: Record<CanonicalNeighborhood, readonly string[]> = {
  'Old North': ['Old North', 'הצפון הישן', 'הצפון הישן - החלק הצפוני', 'הצפון הישן-החלק הדרומי'],
  'New North': ['New North', 'הצפון החדש', 'כיכר המדינה', 'ככר המדינה', 'Kikar HaMedina', 'Kikar Hamedina'],
  'Park Tzameret': ['Park Tzameret', 'Tzameret', 'Park Tsameret', 'פארק צמרת', 'צמרות איילון', 'Tzamarot Ayalon'],
  Bavli: ['Bavli', 'בבלי', 'שיכון בבלי', 'Shikun Bavli'],
  'Lev HaIr': ['Lev HaIr', 'Lev Hair', 'Lev Ha Ir', 'Lev Tel Aviv', 'לב העיר', 'לב תל אביב', 'City Center', 'City Centre'],
  'Neve Tzedek': ['Neve Tzedek', 'Neve Tsedek', 'Neve Zedek', 'נווה צדק'],
  'Kerem HaTeimanim': ['Kerem HaTeimanim', 'Kerem Hateimanim', 'Kerem Hatemanim', 'כרם התימנים', 'Yemenite Quarter'],
  Florentin: ['Florentin', 'Florentine', 'פלורנטין'],
  Jaffa: [
    'Jaffa',
    'Yafo',
    'יפו',
    'צפון יפו',
    "יפו ג'",
    "יפו ד'",
    "יפו ג' ונוה גולן",
    'נוה גולן',
    "עג'מי",
    'Ajami',
    "עג'מי וגבעת עליה",
    'גבעת העליה',
    'גבעת עליה',
    'Givat Aliya',
    'גבעת התמרים',
    "(יפו ד' (גבעת התמרים",
    'צהלון',
    'שיכוני חסכון',
    'צהלון ושיכוני חסכון',
    'דקר',
    'מכללת יפו תל אביב ודקר',
    'גבעת הרצל',
    'אזור המלאכה יפו',
    'גבעת הרצל, אזור המלאכה-יפו',
    'Noga',
  ],
  'Old Jaffa': ['Old Jaffa', 'Old Yafo', 'יפו העתיקה', 'נמל יפו', 'יפו העתיקה,נמל יפו', 'Jaffa Port'],
  Shapira: ['Shapira', 'Shapiro', 'שפירא'],
  'Yad Eliyahu': ['Yad Eliyahu', 'יד אליהו'],
  'Ramat Aviv': ['Ramat Aviv', 'רמת אביב', 'רמת-אביב', "רמת אביב א'", "רמת אביב ב'", "רמת אביב ג'", 'Ramat Aviv Gimel'],
  'Kiryat Shalom': ['Kiryat Shalom', 'קרית שלום'],
  'Neve Shaanan': ['Neve Shaanan', "Neve Sha'anan", 'נווה שאנן'],
}

/** Every subdivision of these areas belongs to the zone (e.g. "הצפון הישן החלק הדרום מערבי", "לב העיר צפון"). */
const PREFIX_FAMILIES: [string, CanonicalNeighborhood][] = [
  ['הצפון הישן', 'Old North'],
  ['Old North', 'Old North'],
  ['הצפון החדש', 'New North'],
  ['New North', 'New North'],
  ['לב העיר', 'Lev HaIr'],
  ['לב תל אביב', 'Lev HaIr'],
  ['Lev HaIr', 'Lev HaIr'],
  ['Lev Hair', 'Lev HaIr'],
].map(([prefix, zone]) => [geoKey(prefix), zone as CanonicalNeighborhood])

/**
 * Source names checked and deliberately NOT mapped: they straddle zones, sit outside every zone,
 * or are too vague. Kept here so the audit can report them as refusals rather than gaps.
 */
export const REFUSED_SOURCE_NAMES: Record<string, string> = {
  'רמת אביב החדשה': 'Ramat Aviv HaHadasha is outside the municipal Ramat Aviv polygons (borders Lamed / Tel Baruch).',
  'נחלת בנימין': 'Nahalat Binyamin spans Lev HaIr and Florentin; resolved by house number instead.',
  'שרונה': 'Sarona is its own municipal neighborhood (Gani Sarona), not part of any zone.',
  'קרית הממשלה': 'Kiryat HaMemshala sits in Gani Sarona / Montefiore, not part of any zone.',
  'מע"ר צפוני': 'Northern business district, no single zone.',
  'המושבה האמריקאית-גרמנית': 'American-German Colony is on the Jaffa / Neve Tzedek edge; ambiguous.',
  'הרכבת': 'HaRakevet is ambiguous (railway area, several candidates).',
  'נווה אביבים': 'Neve Avivim is its own municipal neighborhood, not Ramat Aviv.',
}

const aliasLookup = new Map<string, CanonicalNeighborhood>()
for (const zone of CANONICAL_NEIGHBORHOODS) {
  aliasLookup.set(geoKey(zone), zone)
  for (const alias of SOURCE_ALIASES[zone]) aliasLookup.set(geoKey(alias), zone)
}
const refusedKeys = new Set(Object.keys(REFUSED_SOURCE_NAMES).map(geoKey))

/** Raw source neighborhood → zone. Unknown, refused and empty values return null (never guessed). */
export function zoneFromSourceName(raw: string | null | undefined): CanonicalNeighborhood | null {
  const key = geoKey(raw)
  if (!key || refusedKeys.has(key)) return null
  const exact = aliasLookup.get(key)
  if (exact) return exact
  for (const [prefix, zone] of PREFIX_FAMILIES) if (key.startsWith(prefix)) return zone
  return null
}

export function isRefusedSourceName(raw: string | null | undefined) {
  return refusedKeys.has(geoKey(raw))
}

/** All alias spellings per zone, for free-text scanning. */
export function zoneAliasesForText(): [CanonicalNeighborhood, string[]][] {
  return CANONICAL_NEIGHBORHOODS.map((zone) => [zone, [zone, ...SOURCE_ALIASES[zone]]])
}

export function isCanonicalCity(city: string | null | undefined) {
  return geoKey(city) === geoKey(CANONICAL_CITY)
}
