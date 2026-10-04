import { AMENITY_KEYS, type AmenityKey } from './listings'
import { EMPTY_FILTERS, ROOM_OPTIONS, type Filters, type SortKey } from './filters'

export type TabKey = 'all' | 'rent' | 'sale' | 'saved' | 'favorites'

export type DashboardUrlState = {
  filters: Filters
  tab: TabKey
  sort: SortKey
}

export type RawSearchParams = Record<string, string | string[] | undefined>

const TABS: readonly TabKey[] = ['all', 'rent', 'sale', 'saved', 'favorites']
const SORTS: readonly SortKey[] = ['newest', 'price-asc', 'price-desc', 'surface-desc']
const MAX_TEXT_LENGTH = 80

export const DEFAULT_URL_STATE: DashboardUrlState = { filters: EMPTY_FILTERS, tab: 'all', sort: 'newest' }

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

function text(value: string | string[] | undefined) {
  const v = first(value).slice(0, MAX_TEXT_LENGTH)
  return v === '' ? null : v
}

function digits(value: string | string[] | undefined) {
  const v = first(value)
  return /^\d{1,9}$/.test(v) ? v : ''
}

function rooms(value: string | string[] | undefined) {
  const v = first(value)
  return ROOM_OPTIONS.includes(v) ? v : null
}

function amenities(value: string | string[] | undefined): AmenityKey[] {
  const allowed = new Set<string>(AMENITY_KEYS)
  const parts = first(value).split(',').filter((a) => allowed.has(a))
  return [...new Set(parts)] as AmenityKey[]
}

const MAX_NEIGHBORHOODS = 20

/** `neighborhoods=A,B`; the legacy single `neighborhood=A` param is still accepted. */
function neighborhoodList(params: RawSearchParams): string[] {
  const raw = first(params.neighborhoods) || first(params.neighborhood)
  const parts = raw
    .split(',')
    .map((n) => n.trim().slice(0, MAX_TEXT_LENGTH))
    .filter(Boolean)
  return [...new Set(parts)].slice(0, MAX_NEIGHBORHOODS)
}

export function parseDashboardParams(params: RawSearchParams): DashboardUrlState {
  const tab = first(params.tab) as TabKey
  const sort = first(params.sort) as SortKey
  return {
    tab: TABS.includes(tab) ? tab : 'all',
    sort: SORTS.includes(sort) ? sort : 'newest',
    filters: {
      city: text(params.city),
      neighborhoods: neighborhoodList(params),
      propertyType: text(params.propertyType),
      minPrice: digits(params.minPrice),
      maxPrice: digits(params.maxPrice),
      minRooms: rooms(params.minRooms),
      maxRooms: rooms(params.maxRooms),
      minSurface: digits(params.minSurface),
      maxSurface: digits(params.maxSurface),
      amenities: amenities(params.amenities),
    },
  }
}

export function serializeDashboardParams({ filters, tab, sort }: DashboardUrlState) {
  const params = new URLSearchParams()
  if (tab !== 'all') params.set('tab', tab)
  const scalar = [
    'city',
    'propertyType',
    'minPrice',
    'maxPrice',
    'minRooms',
    'maxRooms',
    'minSurface',
    'maxSurface',
  ] as const
  for (const key of scalar) {
    const value = filters[key]
    if (value) params.set(key, value)
  }
  if (filters.neighborhoods.length) params.set('neighborhoods', filters.neighborhoods.join(','))
  if (filters.amenities.length) params.set('amenities', filters.amenities.join(','))
  if (sort !== 'newest') params.set('sort', sort)
  return params.toString()
}
