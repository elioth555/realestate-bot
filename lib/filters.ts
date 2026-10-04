import type { AmenityKey, DealType, Listing } from './listings'
import { AMENITY_LABELS } from './listings'
import { compileQuery, evaluateListing } from './matching/engine'

export type Filters = {
  city: string | null
  /** Any-of: a listing matches when it is in one of these neighborhoods. Empty = any neighborhood. */
  neighborhoods: string[]
  minPrice: string
  maxPrice: string
  minRooms: string | null
  maxRooms: string | null
  minSurface: string
  maxSurface: string
  propertyType: string | null
  amenities: AmenityKey[]
}

export type DealScope = 'all' | DealType

export type SortKey = 'newest' | 'price-asc' | 'price-desc' | 'surface-desc'

export type SavedSearch = {
  id: string
  name: string
  scope: DealScope
  filters: Filters
  createdAt: string
}

export const EMPTY_FILTERS: Filters = {
  city: null,
  neighborhoods: [],
  minPrice: '',
  maxPrice: '',
  minRooms: null,
  maxRooms: null,
  minSurface: '',
  maxSurface: '',
  propertyType: null,
  amenities: [],
}

export const ROOM_OPTIONS = ['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5', '6']

/** Dashboard results: confirmed and possible matches, per the criterion rules in lib/matching/engine. */
export function filterListings(listings: Listing[], filters: Filters, scope: DealScope) {
  const query = compileQuery(filters, scope)
  return listings.filter((l) => evaluateListing(l, query).status !== 'NO_MATCH')
}

export function sortListings(listings: Listing[], sort: SortKey) {
  const copy = [...listings]
  switch (sort) {
    case 'price-asc':
      return copy.sort((a, b) => a.price - b.price)
    case 'price-desc':
      return copy.sort((a, b) => b.price - a.price)
    case 'surface-desc':
      return copy.sort((a, b) => b.surface - a.surface)
    default:
      return copy.sort((a, b) => a.publishedMinutesAgo - b.publishedMinutesAgo)
  }
}

export function describeFilters(filters: Filters, scope: DealScope): string[] {
  const parts: string[] = []
  if (scope !== 'all') parts.push(scope === 'rent' ? 'Rent' : 'Sale')
  if (filters.city) parts.push(filters.city)
  if (filters.neighborhoods.length) parts.push(filters.neighborhoods.join(', '))
  if (filters.propertyType) parts.push(filters.propertyType)
  if (filters.minPrice || filters.maxPrice) {
    parts.push(`₪${filters.minPrice || '0'} – ${filters.maxPrice ? `₪${filters.maxPrice}` : 'any'}`)
  }
  if (filters.minRooms || filters.maxRooms) {
    parts.push(`${filters.minRooms ?? 'any'}–${filters.maxRooms ?? 'any'} rooms`)
  }
  if (filters.minSurface || filters.maxSurface) {
    parts.push(`${filters.minSurface || '0'}–${filters.maxSurface || 'any'} m²`)
  }
  for (const a of filters.amenities) parts.push(AMENITY_LABELS[a])
  return parts
}

export function countActiveFilters(filters: Filters) {
  let count = filters.amenities.length + (filters.neighborhoods.length > 0 ? 1 : 0)
  for (const key of [
    'city',
    'minPrice',
    'maxPrice',
    'minRooms',
    'maxRooms',
    'minSurface',
    'maxSurface',
    'propertyType',
  ] as const) {
    if (filters[key]) count++
  }
  return count
}

export function formatPrice(price: number) {
  return `₪${new Intl.NumberFormat('en-US').format(price)}`
}

export function formatPublished(minutes: number) {
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}
