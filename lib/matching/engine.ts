import type { AmenityKey, Listing } from '../listings'
import type { DealScope, Filters } from '../filters'
import { normalizeCity, normalizeNeighborhood, normalizePropertyType, sameNormalized } from '../normalize'

/** Listing surfaces differ between Yad2, Arnona, owner text and rounding; allow this much slack on both bounds. */
export const SURFACE_TOLERANCE_M2 = 2

/**
 * strict:     only a confirmed YES qualifies (UNKNOWN is excluded).
 * permissive: YES confirms, UNKNOWN stays a possible match, only an explicit NO excludes.
 * Common omissions (elevator, pets) are permissive; strong features that should never be assumed are strict.
 */
export type CriterionPolicy = 'strict' | 'permissive'

export const CRITERION_POLICY: Record<AmenityKey, CriterionPolicy> = {
  mamad: 'strict',
  parking: 'strict',
  balcony: 'strict',
  furnished: 'strict',
  garden: 'strict',
  terrace: 'strict',
  pool: 'strict',
  gym: 'strict',
  seaView: 'strict',
  elevator: 'permissive',
  petFriendly: 'permissive',
}

export type MatchStatus = 'CONFIRMED_MATCH' | 'POSSIBLE_MATCH' | 'NO_MATCH'

export type MatchResult = {
  status: MatchStatus
  confirmedCriteria: string[]
  unknownCriteria: string[]
  failedCriteria: string[]
}

function toNumber(value: string | null) {
  if (value === null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

type Bounds = { min: number | null; max: number | null }

function checkRange(value: number | null, { min, max }: Bounds, tolerance = 0): 'pass' | 'fail' | 'skip' {
  if (min === null && max === null) return 'skip'
  if (value === null) return 'fail'
  if (min !== null && value < min - tolerance) return 'fail'
  if (max !== null && value > max + tolerance) return 'fail'
  return 'pass'
}

export type CompiledQuery = {
  filters: Filters
  scope: DealScope
  price: Bounds
  rooms: Bounds
  surface: Bounds
}

export function compileQuery(filters: Filters, scope: DealScope): CompiledQuery {
  return {
    filters,
    scope,
    price: { min: toNumber(filters.minPrice), max: toNumber(filters.maxPrice) },
    rooms: { min: toNumber(filters.minRooms), max: toNumber(filters.maxRooms) },
    surface: { min: toNumber(filters.minSurface), max: toNumber(filters.maxSurface) },
  }
}

export function evaluateListing(listing: Listing, query: CompiledQuery): MatchResult {
  const { filters, scope } = query
  const confirmed: string[] = []
  const unknown: string[] = []
  const failed: string[] = []
  const record = (name: string, ok: boolean) => (ok ? confirmed : failed).push(name)

  if (scope !== 'all') record('dealType', listing.dealType === scope)
  if (filters.city) record('city', sameNormalized(normalizeCity, listing.city, filters.city))
  if (filters.neighborhoods.length)
    record(
      'neighborhood',
      filters.neighborhoods.some((n) => sameNormalized(normalizeNeighborhood, listing.neighborhood, n)),
    )
  if (filters.propertyType)
    record('propertyType', sameNormalized(normalizePropertyType, listing.propertyType, filters.propertyType))

  const numeric: [string, number | null, Bounds, number][] = [
    ['price', listing.known.price ? listing.price : null, query.price, 0],
    ['rooms', listing.known.rooms ? listing.rooms : null, query.rooms, 0],
    ['surface', listing.known.surface ? listing.surface : null, query.surface, SURFACE_TOLERANCE_M2],
  ]
  for (const [name, value, bounds, tolerance] of numeric) {
    const result = checkRange(value, bounds, tolerance)
    if (result !== 'skip') record(name, result === 'pass')
  }

  for (const key of filters.amenities) {
    const state = listing.features[key]
    if (state === 'yes') confirmed.push(key)
    else if (state === 'no') failed.push(key)
    else if (CRITERION_POLICY[key] === 'permissive') unknown.push(key)
    else failed.push(key)
  }

  const status: MatchStatus = failed.length ? 'NO_MATCH' : unknown.length ? 'POSSIBLE_MATCH' : 'CONFIRMED_MATCH'
  return { status, confirmedCriteria: confirmed, unknownCriteria: unknown, failedCriteria: failed }
}
