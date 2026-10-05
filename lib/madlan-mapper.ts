import type { PropertyInput } from '@/lib/import-listing'
import type { AmenityKey, ProtectedSpaceType } from './listings'
import { deriveFeatures, type DerivedFeatures, type FeatureEvidence } from './matching/features'
import { normalizePropertyType } from './normalize'

/** One raw item from the swerve/madlan-scraper dataset. */
export type MadlanItem = Record<string, unknown>

/** Useful Madlan fields with no column in the current `properties` schema. Kept for reporting / future columns. */
export type MadlanExtras = {
  external_id: string | null
  address: string | null
  house_number: string | null
  latitude: number | null
  longitude: number | null
  total_floors: number | null
  vaad_bait: number | null
  price_per_sqm: number | null
  currency: string | null
  property_condition: string | null
  protected_space_type: ProtectedSpaceType | null
  air_conditioning: boolean | null
  barrier_free: boolean | null
  contact_name: string | null
  contact_type: string | null
  has_agent: boolean | null
  first_seen: string | null
  scraped_at: string | null
  floorplan_urls: string[]
}

export type MadlanMapResult = {
  /** Row for `properties`, ready for upsertPropertyBySourceUrl. */
  property: PropertyInput
  /** Final tri-state amenities, computed by the shared engine (structured flags + description). */
  derived: DerivedFeatures
  /** Ordered, de-duplicated photo URLs for replacePropertyPhotos. */
  photoUrls: string[]
  extras: MadlanExtras
}

const MAX_PHOTOS_PER_LISTING = 50
const URL_KEYS = ['url', 'src', 'href', 'image', 'imageUrl', 'image_url']
const GROUND_FLOOR_STRINGS = ['קרקע', 'ground', 'ground floor']

/** Madlan structured flag → engine amenity key. */
const FLAG_FIELDS: Partial<Record<AmenityKey, string>> = {
  elevator: 'hasElevator',
  balcony: 'hasBalcony',
  mamad: 'hasSecureRoom',
  garden: 'hasGarden',
  pool: 'hasPool',
  terrace: 'hasTerrace',
  petFriendly: 'petsAllowed',
  furnished: 'isFurnished',
}

function cleanString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const str = cleanString(value)
  if (!str) return null
  const match = str.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

function toFloor(value: unknown): number | null {
  const str = cleanString(value)?.toLowerCase()
  if (str && GROUND_FLOOR_STRINGS.some((g) => str.includes(g))) return 0
  return toNumber(value)
}

function toBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function toIsoDate(value: unknown): string | null {
  const str = cleanString(value)
  return str && Number.isFinite(new Date(str).getTime()) ? str : null
}

function toTransactionType(value: unknown): 'rent' | 'sale' | null {
  const str = cleanString(value)?.toLowerCase()
  if (!str) return null
  if (str === 'rent' || str === 'rental') return 'rent'
  if (str === 'buy' || str === 'sale' || str === 'sell') return 'sale'
  return null
}

function inferCondition(value: unknown): Pick<PropertyInput, 'renovated' | 'new_building'> {
  const condition = cleanString(value)?.toLowerCase().replace(/[\s_-]/g, '')
  if (!condition) return { renovated: null, new_building: null }
  if (['new', 'fromcontractor', 'newfromcontractor', 'asnew'].includes(condition)) {
    return { renovated: null, new_building: true }
  }
  if (['needsrenovation', 'requiresrenovation', 'torenovate'].includes(condition)) {
    return { renovated: false, new_building: false }
  }
  if (condition === 'renovated') return { renovated: true, new_building: null }
  return { renovated: null, new_building: null }
}

function toHttpUrl(value: unknown): string | null {
  let candidate = value
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const obj = candidate as Record<string, unknown>
    candidate = URL_KEYS.map((k) => obj[k]).find((v) => typeof v === 'string')
  }
  const str = cleanString(candidate)
  if (!str) return null
  try {
    const url = new URL(str)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function extractUrls(value: unknown, limit = MAX_PHOTOS_PER_LISTING): string[] {
  if (!Array.isArray(value)) return []
  const urls = new Set<string>()
  for (const entry of value) {
    const url = toHttpUrl(entry)
    if (url) urls.add(url)
    if (urls.size >= limit) break
  }
  return [...urls]
}

function resolveSourceUrl(item: MadlanItem): string | null {
  const url = toHttpUrl(item.url)
  if (url) return url
  const id = cleanString(item.id)
  return id ? `https://www.madlan.co.il/listings/${encodeURIComponent(id)}` : null
}

function buildStreet(item: MadlanItem): string | null {
  const street = cleanString(item.streetName)
  const number = cleanString(item.streetNumber)
  if (street && number && !street.includes(number)) return `${street} ${number}`
  return street
}

/**
 * Structured flags as evidence for the shared engine.
 * Madlan `false` is not yet confirmed to mean a real NO (the real sample has hasSecureRoom=false next to
 * "מקלט" in the text), so flags are read with the same 'positive-only' semantics as Yad2: true = YES,
 * false/null = UNKNOWN, and NO requires explicit text evidence.
 */
function madlanEvidence(item: MadlanItem, description: string | null): FeatureEvidence {
  const flags: FeatureEvidence['flags'] = {}
  for (const [key, field] of Object.entries(FLAG_FIELDS) as [AmenityKey, string][]) {
    flags[key] = toBoolean(item[field])
  }
  const parkingSpots = toNumber(item.parking)
  flags.parking = parkingSpots === null ? null : parkingSpots > 0
  return {
    flags,
    flagSemantics: 'positive-only',
    protectedSpaceFlagType: 'mamad',
    texts: [description],
  }
}

/**
 * Only structured positives are written to boolean columns; everything else stays NULL and the read path
 * (lib/supabase.ts → deriveFeatures over title + description) re-derives the same final state.
 * Writing text-derived YES into `mamad` would make the read path label a מקלט as a ממ"ד.
 */
function storedFlag(value: boolean | null | undefined): true | null {
  return value === true ? true : null
}

export function mapMadlanItem(item: MadlanItem): MadlanMapResult {
  const description = cleanString(item.description)
  const evidence = madlanEvidence(item, description)
  const derived = deriveFeatures(evidence)
  const propertyType = cleanString(item.propertyType)
  const publishedAt = toIsoDate(item.firstSeen)

  const property: PropertyInput = {
    // Only set when present so a re-import never blanks out existing text or dates.
    ...(description ? { description } : {}),
    ...(publishedAt ? { published_at: publishedAt } : {}),
    source: 'madlan',
    source_url: resolveSourceUrl(item),
    transaction_type: toTransactionType(item.dealType),
    property_type: propertyType ? normalizePropertyType(propertyType) : null,
    city: cleanString(item.cityHebrew) ?? cleanString(item.city),
    neighborhood: cleanString(item.neighbourhood) ?? cleanString(item.neighborhood),
    street: buildStreet(item),
    phone: cleanString(item.contactPhone),
    price: toNumber(item.price),
    rooms: toNumber(item.rooms),
    surface_m2: toNumber(item.areaSqm),
    floor: toFloor(item.floor),
    parking: storedFlag(evidence.flags.parking),
    elevator: storedFlag(evidence.flags.elevator),
    balcony: storedFlag(evidence.flags.balcony),
    mamad: storedFlag(evidence.flags.mamad),
    garden: storedFlag(evidence.flags.garden),
    pool: storedFlag(evidence.flags.pool),
    terrace: storedFlag(evidence.flags.terrace),
    pet_friendly: storedFlag(evidence.flags.petFriendly),
    furnished: storedFlag(evidence.flags.furnished),
    ...inferCondition(item.condition),
  }

  const extras: MadlanExtras = {
    external_id: cleanString(item.id),
    address: cleanString(item.address),
    house_number: cleanString(item.streetNumber),
    latitude: toNumber(item.latitude),
    longitude: toNumber(item.longitude),
    total_floors: toNumber(item.totalFloors),
    vaad_bait: toNumber(item.vaadBait),
    price_per_sqm: toNumber(item.pricePerSqm),
    currency: cleanString(item.currency),
    property_condition: cleanString(item.condition),
    protected_space_type: derived.protectedSpaceType,
    air_conditioning: toBoolean(item.hasAirConditioning),
    barrier_free: toBoolean(item.isBarrierFree),
    contact_name: cleanString(item.contactName),
    contact_type: cleanString(item.contactType),
    has_agent: toBoolean(item.hasAgent),
    first_seen: toIsoDate(item.firstSeen),
    scraped_at: toIsoDate(item.scrapedAt),
    floorplan_urls: extractUrls(item.floorplanImages),
  }

  return { property, derived, photoUrls: extractUrls(item.images), extras }
}
