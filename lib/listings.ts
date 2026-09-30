export type DealType = 'rent' | 'sale'
export type Source = 'facebook' | 'yad2' | 'madlan' | 'other'

export const AMENITY_KEYS = [
  'parking',
  'mamad',
  'balcony',
  'elevator',
  'furnished',
  'terrace',
  'garden',
  'pool',
  'gym',
  'seaView',
  'petFriendly',
] as const

export type AmenityKey = (typeof AMENITY_KEYS)[number]

export const AMENITY_LABELS: Record<AmenityKey, string> = {
  parking: 'Parking',
  mamad: 'Mamad',
  balcony: 'Balcony',
  elevator: 'Elevator',
  furnished: 'Furnished',
  terrace: 'Terrace',
  garden: 'Garden',
  pool: 'Pool',
  gym: 'Gym',
  seaView: 'Sea view',
  petFriendly: 'Pet friendly',
}

export const SOURCE_LABELS: Record<Source, string> = {
  facebook: 'Facebook',
  yad2: 'Yad2',
  madlan: 'Madlan',
  other: 'Other',
}

export type Listing = {
  id: string
  title: string
  dealType: DealType
  price: number
  city: string
  neighborhood: string
  street: string
  rooms: number
  surface: number
  floor: number | null
  propertyType: string
  amenities: AmenityKey[]
  phone: string
  source: Source
  url: string
  publishedMinutesAgo: number
  image: string | null
}

export function buildCityIndex(listings: Listing[]) {
  const index = new Map<string, Set<string>>()
  for (const l of listings) {
    if (!l.city) continue
    const set = index.get(l.city) ?? new Set<string>()
    if (l.neighborhood) set.add(l.neighborhood)
    index.set(l.city, set)
  }
  const sorted: Record<string, string[]> = {}
  for (const city of [...index.keys()].sort((a, b) => a.localeCompare(b))) {
    sorted[city] = [...index.get(city)!].sort((a, b) => a.localeCompare(b))
  }
  return sorted
}

export function collectPropertyTypes(listings: Listing[]) {
  return [...new Set(listings.map((l) => l.propertyType).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}
