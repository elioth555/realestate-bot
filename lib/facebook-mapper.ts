import { requiredFieldsFor, type PropertyInput } from '@/lib/import-listing'
import type { ProtectedSpaceType } from './listings'
import { deriveFeatures, type DerivedFeatures } from './matching/features'
import { CITY_ALIASES, NEIGHBORHOOD_ALIASES, normalizeCity, normalizeNeighborhood, normalizePropertyType } from './normalize'

/** One raw item from the swerve/fb-group-scraper dataset. */
export type FacebookItem = Record<string, unknown>

export type PostIntent = 'offer' | 'seeking' | 'unknown'

/** Useful Facebook fields with no column in the current `properties` schema. */
export type FacebookExtras = {
  fb_post_id: string | null
  fb_group_id: string | null
  author_name: string | null
  likes_count: number | null
  comments_count: number | null
  /** All Israeli phone numbers found in the text, normalized to local digits (e.g. 0541234567). */
  phones: string[]
  total_floors: number | null
  protected_space_type: ProtectedSpaceType | null
  /** "מחפש/ת דירה" posts are seekers, not listings; the importer should skip them. */
  post_intent: PostIntent
}

export type FacebookMapResult = {
  property: PropertyInput
  derived: DerivedFeatures
  /** The chosen actor returns no usable photo URLs, so this is always empty for now. */
  photoUrls: string[]
  extras: FacebookExtras
  /** Facebook-required import fields (lib/import-listing requiredFieldsFor) that could not be extracted. */
  missingRequired: string[]
}

const REQUIRED = requiredFieldsFor('facebook') as readonly (keyof PropertyInput)[]

const BEFORE = '(?<![\\p{L}\\p{N}])'
const AFTER = '(?![\\p{L}\\p{N}])'
const HE_PREFIX = '(?:וב|ומ|מה|[בלמוהש])?'
const QUOTE = `["'\u05F3\u05F4\u201C\u201D]`

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function toCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toIsoDate(value: unknown): string | null {
  const str = cleanString(value)
  return str && Number.isFinite(new Date(str).getTime()) ? str : null
}

function escapeRegex(char: string) {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

/** Alias → tolerant pattern: quotes optional, spaces/hyphens interchangeable. */
function aliasPattern(alias: string) {
  let out = ''
  for (const char of alias) {
    if (/["'\u05F3\u05F4]/.test(char)) out += `${QUOTE}?`
    else if (/[\s\-\u05BE]/.test(char)) out += '[\\s\\-\u05BE]+'
    else out += escapeRegex(char)
  }
  return out.replace(/(\[\\s\\-\u05BE\]\+)+/g, '[\\s\\-\u05BE]+')
}

type Span = { start: number; end: number; canonical: string }

/** Longest alias match wins; returns all non-overlapping spans so callers can mask them. */
function findAliases(text: string, table: Record<string, readonly string[]>, normalize: (v: string) => string): Span[] {
  const candidates: Span[] = []
  for (const [canonical, aliases] of Object.entries(table)) {
    for (const alias of [canonical, ...aliases]) {
      const re = new RegExp(`${BEFORE}${HE_PREFIX}(${aliasPattern(alias)})${AFTER}`, 'giu')
      for (const m of text.matchAll(re)) {
        const start = m.index! + m[0].length - m[1].length
        candidates.push({ start, end: start + m[1].length, canonical: normalize(canonical) })
      }
    }
  }
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
  const chosen: Span[] = []
  for (const span of candidates) {
    if (!chosen.some((c) => span.start < c.end && c.start < span.end)) chosen.push(span)
  }
  return chosen.sort((a, b) => a.start - b.start)
}

function mask(text: string, spans: { start: number; end: number }[]) {
  let out = text
  for (const { start, end } of spans) out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end)
  return out
}

// ---------- identifiers ----------

function parseFacebookUrl(value: unknown) {
  const raw = cleanString(value)
  if (!raw) return { sourceUrl: null, groupId: null, postId: null }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { sourceUrl: null, groupId: null, postId: null }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { sourceUrl: null, groupId: null, postId: null }
  const path = url.pathname.match(/\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/)
  const groupId = path?.[1] ?? url.searchParams.get('id')
  const postId = path?.[2] ?? url.searchParams.get('story_fbid')
  const sourceUrl =
    groupId && postId ? `https://www.facebook.com/groups/${groupId}/posts/${postId}/` : url.toString()
  return { sourceUrl, groupId, postId }
}

// ---------- phones ----------

const PHONE_RE = /(?<![\d+])(?:\+?972[\s-]?|0)(?:5\d|7\d|[23489])(?:[\s-]?\d){7}(?!\d)/g

function normalizePhone(match: string): string | null {
  let digits = match.replace(/\D/g, '')
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`
  return /^0(?:5\d{8}|7\d{8}|[23489]\d{7})$/.test(digits) ? digits : null
}

function extractPhones(text: string) {
  const phones: string[] = []
  const spans: { start: number; end: number }[] = []
  for (const m of text.matchAll(PHONE_RE)) {
    const phone = normalizePhone(m[0])
    if (!phone) continue
    spans.push({ start: m.index!, end: m.index! + m[0].length })
    if (!phones.includes(phone)) phones.push(phone)
  }
  return { phones, spans }
}

// ---------- deal type & intent ----------

const RENT_RE = new RegExp(
  `${BEFORE}(?:[לוב])?(?:השכרה|שכירות|סאבלט)${AFTER}|${BEFORE}שכ${QUOTE}ד${AFTER}|\\bfor\\s+rent\\b|\\brental\\b|\\bto\\s+let\\b|\\bsublet\\b`,
  'iu',
)
const SALE_RE = new RegExp(`${BEFORE}(?:[לו])?מכירה${AFTER}|${BEFORE}נמכרת${AFTER}|\\bfor\\s+sale\\b`, 'iu')
const SEEKING_RE = new RegExp(
  `${BEFORE}(?:מחפש|מחפשת|מחפשים|מחפשות|דרוש|דרושה)${AFTER}|\\blooking\\s+for\\b|\\bsearching\\s+for\\b`,
  'iu',
)

function detectTransaction(text: string): 'rent' | 'sale' | null {
  const rent = RENT_RE.test(text)
  const sale = SALE_RE.test(text)
  if (rent === sale) return null
  return rent ? 'rent' : 'sale'
}

// ---------- property type ----------

const PROPERTY_TYPES: [string, RegExp][] = [
  ['garden apartment', new RegExp(`${BEFORE}${HE_PREFIX}דירת\\s+גן${AFTER}|\\bgarden\\s+apartment\\b`, 'iu')],
  ['penthouse', new RegExp(`${BEFORE}${HE_PREFIX}(?:פנטהאוז|פנטהאוס|דירת\\s+גג)${AFTER}|\\bpenthouse\\b`, 'iu')],
  ['duplex', new RegExp(`${BEFORE}${HE_PREFIX}דופלקס${AFTER}|\\bduplex\\b`, 'iu')],
  ['studio', new RegExp(`${BEFORE}${HE_PREFIX}(?:סטודיו|לופט)${AFTER}|\\b(?:studio|loft)\\b`, 'iu')],
  ['house', new RegExp(`${BEFORE}${HE_PREFIX}(?:בית\\s+פרטי|קוטג${QUOTE}|וילה)${AFTER}|\\b(?:private\\s+house|cottage|villa)\\b`, 'iu')],
  ['apartment', new RegExp(`${BEFORE}${HE_PREFIX}(?:דירה|דירת)${AFTER}|\\b(?:apartment|flat)\\b`, 'iu')],
]

function detectPropertyType(text: string): string | null {
  const hit = PROPERTY_TYPES.find(([, re]) => re.test(text))
  return hit ? normalizePropertyType(hit[0]) : null
}

// ---------- rooms ----------

const RANGE_BEFORE = '(?<![\\d.,]\\s*[-\u2013]\\s*)(?<![\\d.,])'
const ROOMS_HE = new RegExp(
  `${RANGE_BEFORE}(\\d{1,2}(?:[.,]5)?)(\\s*וחצי)?\\s*(?:חדרים|חד${QUOTE}|חדר${AFTER})(?!\\s*[-\u2013]\\s*\\d)`,
  'u',
)
const ROOMS_EN = new RegExp(`${RANGE_BEFORE}(\\d{1,2}(?:\\.5)?)\\s*-?\\s*rooms?\\b`, 'iu')
const ROOM_AND_HALF = new RegExp(`${BEFORE}${HE_PREFIX}חדר\\s+וחצי${AFTER}`, 'u')

function parseRooms(text: string): number | null {
  const he = text.match(ROOMS_HE)
  if (he) {
    const rooms = Number(he[1].replace(',', '.')) + (he[2] ? 0.5 : 0)
    return rooms >= 1 && rooms <= 15 ? rooms : null
  }
  if (ROOM_AND_HALF.test(text)) return 1.5
  const en = text.match(ROOMS_EN)
  if (en) {
    const rooms = Number(en[1])
    return rooms >= 1 && rooms <= 15 ? rooms : null
  }
  return null
}

// ---------- surface ----------

const SURFACE_RE = new RegExp(
  `(?<![\\d.,])(\\d{2,4}(?:[.,]\\d+)?)\\s*(?:מ${QUOTE}ר${AFTER}|מטר(?:ים)?\\s+רבוע(?:ים)?${AFTER}|sqm\\b|sq\\.?\\s?m\\b|m2\\b|m\u00B2|square\\s+met(?:er|re)s?\\b)`,
  'giu',
)
// "גינה 40 מ"ר" / "מרפסת 12 מ"ר" describe the outdoor space, not the apartment.
const OUTDOOR_BEFORE = /(?:גינה|גינת|מרפסת|חצר|מחסן|garden|balcony|terrace|yard)[^\d\n]{0,10}$/iu

function parseSurface(text: string): number | null {
  for (const m of text.matchAll(SURFACE_RE)) {
    if (OUTDOOR_BEFORE.test(text.slice(Math.max(0, m.index! - 16), m.index!))) continue
    const value = Number(m[1].replace(',', '.'))
    if (value >= 10 && value <= 2000) return value
  }
  return null
}

// ---------- floor ----------

const HE_ORDINALS: Record<string, number> = {
  ראשונה: 1, שנייה: 2, שניה: 2, שלישית: 3, רביעית: 4, חמישית: 5,
  שישית: 6, שביעית: 7, שמינית: 8, תשיעית: 9, עשירית: 10,
}
const GROUND_RE = new RegExp(`${BEFORE}${HE_PREFIX}קומ(?:ה|ת)[\\s-]*קרקע${AFTER}|\\bground\\s+floor\\b`, 'iu')
const FLOOR_NUM_HE = new RegExp(
  `${BEFORE}${HE_PREFIX}קומה\\s*:?\\s*(-?\\d{1,2})(?!\\d)(?:\\s*(?:מתוך|\\/)\\s*(\\d{1,2}))?`,
  'u',
)
const FLOOR_WORD_HE = new RegExp(`${BEFORE}${HE_PREFIX}קומה\\s+(${Object.keys(HE_ORDINALS).join('|')})${AFTER}`, 'u')
const FLOOR_EN = /\b(\d{1,2})(?:st|nd|rd|th)?\s+floor\b|\bfloor\s*:?\s*(\d{1,2})\b/i
const TOTAL_FLOORS_EN = /\b(?:out\s+of|of)\s+(\d{1,2})\s+floors?\b/i

function parseFloor(text: string): { floor: number | null; totalFloors: number | null } {
  const num = text.match(FLOOR_NUM_HE)
  if (num) return { floor: Number(num[1]), totalFloors: num[2] ? Number(num[2]) : null }
  if (GROUND_RE.test(text)) return { floor: 0, totalFloors: null }
  const word = text.match(FLOOR_WORD_HE)
  if (word) return { floor: HE_ORDINALS[word[1]], totalFloors: null }
  const en = text.match(FLOOR_EN)
  if (en) {
    const total = text.match(TOTAL_FLOORS_EN)
    return { floor: Number(en[1] ?? en[2]), totalFloors: total ? Number(total[1]) : null }
  }
  return { floor: null, totalFloors: null }
}

// ---------- price ----------

const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)'
const MULT = `(?:\\s?(k|K|אלף)${AFTER})?`
const CURRENCY = `(?:₪|ש${QUOTE}?ח${AFTER}|שקלים${AFTER}|שקל${AFTER}|nis\\b|ils\\b)`
const PRICE_CONTEXT = [
  new RegExp(`₪\\s*${NUM}${MULT}`, 'giu'),
  new RegExp(`(?<![\\d.,])${NUM}${MULT}\\s*${CURRENCY}`, 'giu'),
  new RegExp(
    `${BEFORE}(?:מחיר|שכירות|שכ${QUOTE}ד|שכר\\s+דירה|price|rent)\\s*[:\\-]?\\s*(?:של\\s*|is\\s*)?${NUM}${MULT}(?![\\d,]|\\.\\d)`,
    'giu',
  ),
  new RegExp(`(?<![\\d.,])${NUM}${MULT}\\s*(?:לחודש${AFTER}|לחו${QUOTE}ד|per\\s+month\\b|\\/\\s?month\\b|a\\s+month\\b)`, 'giu'),
]
const PRICE_BARE = new RegExp(
  `(?<![\\d.,])(\\d{1,3}(?:,\\d{3})+)(?![\\d.,])(?!\\s*(?:מ${QUOTE}ר|מטר|sqm|m2|m\u00B2))`,
  'gu',
)
const MIN_PRICE = 500
const MAX_PRICE = 200_000_000

function toPrice(num: string, mult: string | undefined): number | null {
  const value = Number(num.replace(/,/g, '')) * (mult ? 1000 : 1)
  return Number.isFinite(value) && value >= MIN_PRICE && value <= MAX_PRICE ? Math.round(value) : null
}

/** Phones must already be masked out of `text`. Contextual prices win over bare comma-formatted numbers. */
function parsePrice(text: string): number | null {
  let best: { index: number; value: number } | null = null
  for (const re of PRICE_CONTEXT) {
    for (const m of text.matchAll(re)) {
      const value = toPrice(m[1], m[2])
      if (value !== null && (!best || m.index! < best.index)) best = { index: m.index!, value }
    }
  }
  if (best) return best.value
  for (const m of text.matchAll(PRICE_BARE)) {
    const value = toPrice(m[1], undefined)
    if (value !== null) return value
  }
  return null
}

// ---------- street ----------

const STREET_HE = new RegExp(
  `${BEFORE}(?:[בל])?(?:רחוב|רח${QUOTE})\\s*([\\u05D0-\\u05EA${QUOTE.slice(1, -1)}\\-]+(?:\\s+[\\u05D0-\\u05EA${QUOTE.slice(1, -1)}\\-]+){0,2})(?:\\s+(\\d{1,4}[\\u05D0-\\u05EA]?)(?![\\d\\p{L}]))?`,
  'u',
)
const STREET_EN = /\b(?:(\d{1,4})\s+)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:St\.?|Street)\b/
const STREET_STOPWORDS = new Set([
  'ליד', 'פינת', 'קומה', 'בקומה', 'עם', 'יש', 'דירה', 'דירת', 'חדרים', 'להשכרה', 'למכירה',
  'מול', 'כניסה', 'מחיר', 'שכירות', 'מתוך', 'בשכונת', 'שכונת', 'באזור', 'אזור', 'קרוב',
])

function parseStreet(text: string, citySpans: Span[]): string | null {
  const he = STREET_HE.exec(text)
  if (he) {
    const nameStart = he.index + he[0].indexOf(he[1])
    const tokens = he[1].split(/\s+/)
    const kept: string[] = []
    let cursor = nameStart
    let cut = false
    for (const token of tokens) {
      const tokenStart = text.indexOf(token, cursor)
      cursor = tokenStart + token.length
      if (STREET_STOPWORDS.has(token) || citySpans.some((s) => tokenStart < s.end && s.start < cursor)) {
        cut = true
        break
      }
      kept.push(token)
    }
    const name = kept.join(' ').replace(/[-]+$/, '').trim()
    if (!name) return null
    return !cut && he[2] ? `${name} ${he[2]}` : name
  }
  const en = text.match(STREET_EN)
  if (en) return en[1] ? `${en[2]} ${en[1]}` : en[2]
  return null
}

// ---------- mapper ----------

export function mapFacebookItem(item: FacebookItem): FacebookMapResult {
  const rawText = typeof item.text === 'string' && item.text.trim() !== '' ? item.text : null
  const text = rawText ?? ''
  const { sourceUrl, groupId, postId } = parseFacebookUrl(item.url)
  const publishedAt = toIsoDate(item.time)

  const { phones, spans: phoneSpans } = extractPhones(text)
  const withoutPhones = mask(text, phoneSpans)

  const citySpans = findAliases(withoutPhones, CITY_ALIASES, normalizeCity)
  const neighborhoodSpans = findAliases(mask(withoutPhones, citySpans), NEIGHBORHOOD_ALIASES, normalizeNeighborhood)
  const { floor, totalFloors } = parseFloor(withoutPhones)

  // No structured flags exist for Facebook; every amenity comes from the text, so the dashboard read path
  // (deriveFeatures over title + description) reproduces this exactly with all boolean columns left NULL.
  const derived = deriveFeatures({ flags: {}, flagSemantics: 'explicit', texts: [rawText] })
  const transactionType = detectTransaction(text)

  const property: PropertyInput = {
    ...(rawText ? { description: rawText } : {}),
    ...(publishedAt ? { published_at: publishedAt } : {}),
    source: 'facebook',
    source_url: sourceUrl,
    transaction_type: transactionType,
    property_type: detectPropertyType(text),
    city: citySpans[0]?.canonical ?? null,
    neighborhood: neighborhoodSpans[0]?.canonical ?? null,
    street: parseStreet(withoutPhones, citySpans),
    phone: phones[0] ?? null,
    price: parsePrice(withoutPhones),
    rooms: parseRooms(withoutPhones),
    surface_m2: parseSurface(withoutPhones),
    floor,
    parking: null,
    elevator: null,
    balcony: null,
    mamad: null,
    garden: null,
    pool: null,
    gym: null,
    sea_view: null,
    terrace: null,
    pet_friendly: null,
    furnished: null,
  }

  const extras: FacebookExtras = {
    fb_post_id: postId,
    fb_group_id: groupId,
    author_name: cleanString(item.authorName),
    likes_count: toCount(item.likesCount),
    comments_count: toCount(item.commentsCount),
    phones,
    total_floors: totalFloors,
    protected_space_type: derived.protectedSpaceType,
    post_intent: SEEKING_RE.test(text) ? 'seeking' : transactionType ? 'offer' : 'unknown',
  }

  const missingRequired = REQUIRED.filter((field) => property[field] === null || property[field] === undefined)
  return { property, derived, photoUrls: [], extras, missingRequired }
}
