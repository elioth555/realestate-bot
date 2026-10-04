import type { AmenityKey, DealType, Listing } from './listings'
import { AMENITY_LABELS } from './listings'
import { normalizeCity, normalizeNeighborhood, normalizePropertyType, sameNormalized } from './normalize'

export type Filters = {
  city: string | null
  neighborhood: string | null
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
  neighborhood: null,
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

function toNumber(value: string | null) {
  if (value === null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function filterListings(listings: Listing[], filters: Filters, scope: DealScope) {
  const minPrice = toNumber(filters.minPrice)
  const maxPrice = toNumber(filters.maxPrice)
  const minRooms = toNumber(filters.minRooms)
  const maxRooms = toNumber(filters.maxRooms)
  const minSurface = toNumber(filters.minSurface)
  const maxSurface = toNumber(filters.maxSurface)

  return listings.filter((l) => {
    if (scope !== 'all' && l.dealType !== scope) return false
    if (filters.city && !sameNormalized(normalizeCity, l.city, filters.city)) return false
    if (filters.neighborhood && !sameNormalized(normalizeNeighborhood, l.neighborhood, filters.neighborhood))
      return false
    if (filters.propertyType && !sameNormalized(normalizePropertyType, l.propertyType, filters.propertyType))
      return false
    if (minPrice !== null && l.price < minPrice) return false
    if (maxPrice !== null && l.price > maxPrice) return false
    if (minRooms !== null && l.rooms < minRooms) return false
    if (maxRooms !== null && l.rooms > maxRooms) return false
    if (minSurface !== null && l.surface < minSurface) return false
    if (maxSurface !== null && l.surface > maxSurface) return false
    return filters.amenities.every((a) => l.amenities.includes(a))
  })
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
  if (filters.neighborhood) parts.push(filters.neighborhood)
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
  let count = filters.amenities.length
  for (const key of [
    'city',
    'neighborhood',
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
