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
  mamad: 'Mamad / Protected space',
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

export type TriState = 'yes' | 'no' | 'unknown'

export type ProtectedSpaceType = 'mamad' | 'miklat' | 'mamak' | 'other'

/** The broad "Mamad / Protected space" filter matches all of these; cards show the real type. */
export const PROTECTED_SPACE_LABELS: Record<ProtectedSpaceType, string> = {
  mamad: 'Mamad',
  miklat: 'Miklat',
  mamak: 'Mamak',
  other: 'Protected space',
}

export type EntryDate = { kind: 'immediate' } | { kind: 'date'; value: string } | null

export function amenityDisplayLabel(listing: Pick<Listing, 'protectedSpaceType'>, key: AmenityKey) {
  if (key === 'mamad') return PROTECTED_SPACE_LABELS[listing.protectedSpaceType ?? 'other']
  return AMENITY_LABELS[key]
}

export const SOURCE_LABELS: Record<Source, string> = {
  facebook: 'Facebook',
  yad2: 'Yad2',
  madlan: 'Madlan',
  other: 'Other',
}

import { CANONICAL_NEIGHBORHOODS, isCanonicalCity } from './geo/canonical-neighborhoods'

export type Listing = {
  id: string
  title: string
  /** Original source text (the full Facebook post for Facebook listings); empty when not stored. */
  description: string
  dealType: DealType
  price: number
  city: string
  neighborhood: string
  street: string
  rooms: number
  surface: number
  floor: number | null
  propertyType: string
  /** Confirmed (YES) features only, for display. */
  amenities: AmenityKey[]
  /** YES / NO / UNKNOWN per feature, used by the matching engine. */
  features: Record<AmenityKey, TriState>
  protectedSpaceType: ProtectedSpaceType | null
  entryDate: EntryDate
  /** Whether the numeric fields came from the source (false means the displayed 0 is a placeholder). */
  known: { price: boolean; rooms: boolean; surface: boolean }
  phone: string
  source: Source
  url: string
  /** ISO timestamp of publication (falls back to import time); null when neither is known. */
  publishedAt: string | null
  publishedMinutesAgo: number
  photos: string[]
  image: string | null
  /** Other Facebook post URLs for the same apartment, grouped at read time (lib/facebook-dedupe). */
  alsoPostedAt?: string[]
  /** Every source listing merged into this card at read time (lib/cross-source-dedupe), representative first. */
  listedAt?: ListingLink[]
  /** All real phone numbers across the merged source listings. */
  phones?: string[]
}

export type ListingLink = { source: Source; url: string; id: string }

/** Source listings behind a card: the merged list, or just the listing itself. */
export function listingLinks(listing: Listing): ListingLink[] {
  return listing.listedAt?.length ? listing.listedAt : [{ source: listing.source, url: listing.url, id: listing.id }]
}

export function listingSources(listing: Listing): Source[] {
  return [...new Set(listingLinks(listing).map((l) => l.source))]
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
    // Tel Aviv always offers exactly the canonical zones, in their fixed north-to-south order.
    sorted[city] = isCanonicalCity(city)
      ? [...CANONICAL_NEIGHBORHOODS]
      : [...index.get(city)!].sort((a, b) => a.localeCompare(b))
  }
  return sorted
}

export function collectPropertyTypes(listings: Listing[]) {
  return [...new Set(listings.map((l) => l.propertyType).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}
