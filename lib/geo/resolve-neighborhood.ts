import polygonData from './data/tel-aviv-neighborhoods.json' with { type: 'json' }
import streetData from './data/tel-aviv-streets.json' with { type: 'json' }
import {
  type CanonicalNeighborhood,
  geoKey,
  isRefusedSourceName,
  zoneAliasesForText,
  zoneForMunicipalNeighborhood,
  zoneFromSourceName,
} from './canonical-neighborhoods'

/**
 * Deterministic Tel Aviv neighborhood resolution, using only the municipal GIS snapshot in ./data
 * (regenerate with scripts/geo/build-tel-aviv-geo.mts). No network calls, no paid geocoder, no LLM.
 *
 * Order: coordinates → street + house number → source neighborhood → explicit text → street-only.
 * Geography is final: an address inside a municipal neighborhood that belongs to no zone returns null
 * instead of falling back to a weaker signal.
 */

export type ResolutionMethod = 'coordinates' | 'address' | 'source' | 'description' | 'street'

export type NeighborhoodResolution = {
  neighborhood: CanonicalNeighborhood | null
  method: ResolutionMethod | null
  /** Official municipal neighborhood name when geography decided. */
  municipal: string | null
}

export type NeighborhoodInput = {
  latitude?: number | null
  longitude?: number | null
  /** Free street field, e.g. "שבזי 42", "נחמני 13, לב תל אביב", "Dizengoff". */
  street?: string | null
  houseNumber?: number | null
  sourceNeighborhood?: string | null
  /** Free text (Facebook post body). Scanned for "street + number" and explicit neighborhood names. */
  text?: string | null
}

type Ring = number[][]
type Polygon = { ms: number; name: string; bbox: number[]; rings: Ring[] }
type Run = number[] // [from, to, municipalNumber]
type Street = { code: number; he: string; en: string; odd: Run[]; even: Run[] }

const polygons = (polygonData as { polygons: Polygon[] }).polygons
const municipalName = new Map(polygons.map((p) => [p.ms, p.name]))
const streets = (streetData as { streets: Street[] }).streets

const NONE: NeighborhoodResolution = { neighborhood: null, method: null, municipal: null }

// ---------- coordinates ----------

function inRing(x: number, y: number, ring: Ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function municipalAt(latitude: number, longitude: number): number | null {
  for (const p of polygons) {
    const [minX, minY, maxX, maxY] = p.bbox
    if (longitude < minX || longitude > maxX || latitude < minY || latitude > maxY) continue
    let inside = false
    for (const ring of p.rings) if (inRing(longitude, latitude, ring)) inside = !inside
    if (inside) return p.ms
  }
  return null
}

// ---------- street index ----------

const STREET_PREFIXES = ['רחוב', 'רח', 'שדרות', 'שד', 'דרך', 'סמטת', 'סמ', 'street', 'st', 'blvd', 'boulevard']
const prefixPattern = new RegExp(`^(?:${STREET_PREFIXES.join('|')})\\s+`, 'i')
const suffixPattern = /\s+(?:street|st|blvd|boulevard|ave|avenue)$/i

function streetKeys(name: string) {
  const cleaned = name.replace(/["'`\u05F3\u05F4.]/g, '').trim()
  const bare = cleaned.replace(prefixPattern, '').replace(suffixPattern, '')
  return [...new Set([geoKey(cleaned), geoKey(bare)].filter((k) => k.length >= 2))]
}

const streetIndex = new Map<string, Street[]>()
const lastNameIndex = new Map<string, Set<string>>() // English last word → Hebrew street names
function addKey(key: string, street: Street) {
  const list = streetIndex.get(key) ?? []
  if (!list.includes(street)) list.push(street)
  streetIndex.set(key, list)
}
for (const s of streets) {
  for (const key of streetKeys(s.he)) addKey(key, s)
  if (s.en) {
    for (const key of streetKeys(s.en)) addKey(key, s)
    const last = geoKey(s.en.split(/\s+/).pop())
    if (last.length >= 4) (lastNameIndex.get(last) ?? lastNameIndex.set(last, new Set()).get(last)!).add(s.he)
  }
}

/** Exact street lookup; an English surname ("Dizengoff" for "MEIR DIZENGOFF") only when it names one street. */
export function findStreets(name: string | null | undefined): Street[] {
  if (!name) return []
  for (const key of streetKeys(name)) {
    const hit = streetIndex.get(key)
    if (hit) return hit
  }
  const last = lastNameIndex.get(geoKey(name))
  if (last && last.size === 1) return streets.filter((s) => s.he === [...last][0])
  return []
}

function municipalForNumber(street: Street, num: number): number | null {
  const runs = num % 2 ? street.odd : street.even
  let before: Run | null = null
  for (const run of runs) {
    if (num >= run[0] && num <= run[1]) return run[2]
    if (run[1] < num) before = run
    else {
      // In a gap between two runs: only trust it when both sides agree.
      return before && before[2] === run[2] ? run[2] : null
    }
  }
  return null
}

/** One municipal neighborhood for this street + number, or null when unknown or contradictory. */
function municipalForAddress(name: string, num: number): number | null {
  // Several municipal streets can share a name; only those whose ranges contain the number count.
  const results = new Set(findStreets(name).map((s) => municipalForNumber(s, num)).filter((ms) => ms !== null))
  if (results.size !== 1) return null
  return [...results][0]
}

/** The street's single zone when every known address on it lies in that zone; otherwise null. */
function zoneForWholeStreet(name: string): { zone: CanonicalNeighborhood; ms: number } | null {
  const matches = findStreets(name)
  if (!matches.length) return null
  const zones = new Set<CanonicalNeighborhood | null>()
  const municipal = new Set<number>()
  for (const s of matches) {
    for (const run of [...s.odd, ...s.even]) {
      zones.add(zoneForMunicipalNeighborhood(run[2]))
      municipal.add(run[2])
    }
  }
  if (zones.size !== 1) return null
  const zone = [...zones][0]
  return zone ? { zone, ms: [...municipal][0] } : null
}

export function isKnownStreet(name: string | null | undefined) {
  return findStreets(name).length > 0
}

// ---------- parsing ----------

/** "שבזי 42", "נחמני 13, לב תל אביב", "Vital 12", "42 Shabazi St" → { name, number }. */
export function parseStreetField(value: string | null | undefined): { name: string; number: number | null } | null {
  const first = (value ?? '').split(/[,\n|]/)[0].trim()
  if (!first) return null
  const trailing = first.match(/^(.*?\D)\s*(\d{1,4})\s*[א-תa-z]?$/i)
  if (trailing) return { name: trailing[1].trim(), number: Number(trailing[2]) }
  const leading = first.match(/^(\d{1,4})[א-תa-z]?\s+(\D.*)$/i)
  if (leading) return { name: leading[2].trim(), number: Number(leading[1]) }
  return { name: first, number: null }
}

const HE_LETTER = 'א-ת'
const UNIT_AFTER = /^\s*(?:מ"?ר|מטר|חד|חדר|קומ|₪|ש"?ח|אלף|k\b|m2|sqm|rooms?|%|דק)/i
const MARKER = /(?:^|\s)(?:ב|ל)?(?:רחוב|רח'|רח׳|שדרות|שד'|שד׳)\s*$/

/** Every "street + house number" mention in free text that matches a real Tel Aviv street. */
export function findAddressesInText(text: string | null | undefined): { name: string; number: number }[] {
  const source = (text ?? '').replace(/\s+/g, ' ')
  const found: { name: string; number: number }[] = []
  for (const m of source.matchAll(/(\d{1,3})(?!\d)/g)) {
    const index = m.index ?? 0
    const after = source.slice(index + m[0].length)
    if (UNIT_AFTER.test(after) || /^[.,]\d/.test(after)) continue
    const before = source.slice(Math.max(0, index - 45), index)
    const words = before.trimEnd().split(' ')
    for (let n = Math.min(4, words.length); n >= 1; n--) {
      const candidateWords = words.slice(words.length - n)
      let candidate = candidateWords.join(' ').replace(/^[^\p{L}]+|[^\p{L}"'׳״]+$/gu, '')
      if (!candidate) continue
      const preceding = words.slice(0, words.length - n).join(' ')
      const marked = MARKER.test(` ${preceding}`)
      // Hebrew "ב/ל" prefix: "בשבזי 42" → "שבזי"
      const variants = [candidate]
      if (new RegExp(`^[בל][${HE_LETTER}]{3,}`).test(candidate)) variants.push(candidate.slice(1))
      for (const variant of variants) {
        candidate = variant
        if (!marked && geoKey(candidate).length < 3) continue
        if (findStreets(candidate).length) {
          found.push({ name: candidate, number: Number(m[1]) })
          n = 0
          break
        }
      }
    }
  }
  return found
}

const CITY_PHRASES = /תל[\s-]?אביב[\s-]*(?:יפו|-יפו)?|tel[\s-]?aviv(?:[\s-]*(?:yafo|jaffa))?/gi
const PROXIMITY = /(?:קרוב|ליד|סמוך|גובל|במרחק|דקות|דקה|הליכה|near|close to|next to|minutes? from|walking distance)[^.\n]{0,25}$/i

const textPatterns = zoneAliasesForText().map(([zone, aliases]) => {
  const parts = [...new Set(aliases)]
    .sort((a, b) => b.length - a.length)
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['׳]/g, "['׳]?").replace(/[\s-]+/g, '[\\s-]*'))
  return {
    zone,
    re: new RegExp(`(?<![${HE_LETTER}a-z])(?:[בהלמו]|ב-|ל-)?(?:${parts.join('|')})(?![${HE_LETTER}a-z])`, 'giu'),
  }
})

/** The zone a text explicitly says it is in. Null when none, several, or only mentioned as "near X". */
export function zoneFromText(text: string | null | undefined): CanonicalNeighborhood | null {
  const source = (text ?? '').replace(CITY_PHRASES, ' ')
  const zones = new Set<CanonicalNeighborhood>()
  for (const { zone, re } of textPatterns) {
    for (const m of source.matchAll(re)) {
      if (PROXIMITY.test(source.slice(Math.max(0, (m.index ?? 0) - 40), m.index))) continue
      zones.add(zone)
    }
  }
  return zones.size === 1 ? [...zones][0] : null
}

// ---------- resolver ----------

function fromMunicipal(ms: number, method: ResolutionMethod): NeighborhoodResolution {
  return { neighborhood: zoneForMunicipalNeighborhood(ms), method, municipal: municipalName.get(ms) ?? null }
}

export function resolveNeighborhood(input: NeighborhoodInput): NeighborhoodResolution {
  const { latitude, longitude } = input
  if (typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const ms = municipalAt(latitude, longitude)
    if (ms !== null) return fromMunicipal(ms, 'coordinates')
  }

  const parsed = parseStreetField(input.street)
  const number = input.houseNumber ?? parsed?.number ?? null
  if (parsed && number) {
    const ms = municipalForAddress(parsed.name, number)
    if (ms !== null) return fromMunicipal(ms, 'address')
  }

  const textAddresses = findAddressesInText(input.text)
  const textMunicipal = new Set(textAddresses.map((a) => municipalForAddress(a.name, a.number)).filter((ms) => ms !== null))
  if (textMunicipal.size === 1) return fromMunicipal([...textMunicipal][0]!, 'address')

  const sourceZone = zoneFromSourceName(input.sourceNeighborhood)
  if (sourceZone) return { neighborhood: sourceZone, method: 'source', municipal: null }

  const textZone = zoneFromText(input.text)
  if (textZone) return { neighborhood: textZone, method: 'description', municipal: null }

  // Street-only: the street field, or a street name stored in the neighborhood field by the source.
  const streetNames = [parsed?.name]
  if (input.sourceNeighborhood && !isRefusedSourceName(input.sourceNeighborhood)) streetNames.push(input.sourceNeighborhood)
  for (const name of streetNames) {
    if (!name) continue
    const whole = zoneForWholeStreet(name)
    if (whole) return { neighborhood: whole.zone, method: 'street', municipal: municipalName.get(whole.ms) ?? null }
  }

  return NONE
}
