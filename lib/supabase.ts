import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AmenityKey, DealType, Listing, Source } from './listings'

const PHOTOS_TABLE = 'property_photos'
const LEGACY_PHOTOS_TABLE = 'proprety_photos'
const MAX_ROWS = 1000

type PropertyRow = {
  id: string | number
  created_at: string | null
  title: string | null
  transaction_type: string | null
  city: string | null
  neighborhood: string | null
  street: string | null
  price: number | string | null
  rooms: number | string | null
  surface_m2: number | string | null
  floor: number | string | null
  phone: string | null
  source: string | null
  source_url: string | null
  published_at: string | null
  property_type: string | null
  parking: boolean | null
  mamad: boolean | null
  balcony: boolean | null
  elevator: boolean | null
  furnished: boolean | null
  terrace: boolean | null
  garden: boolean | null
  pool: boolean | null
  gym: boolean | null
  sea_view: boolean | null
  pet_friendly: boolean | null
}

type PhotoRow = {
  id: string | number
  property_id: string | number
  photo_url: string | null
  position: number | string | null
}

function groupPhotosByProperty(rows: PhotoRow[]) {
  const grouped = new Map<string, PhotoRow[]>()
  for (const row of rows) {
    if (!row.photo_url || row.property_id === null || row.property_id === undefined) continue
    const key = String(row.property_id)
    const list = grouped.get(key) ?? []
    list.push(row)
    grouped.set(key, list)
  }
  const result = new Map<string, string[]>()
  for (const [key, list] of grouped) {
    list.sort(
      (a, b) =>
        (toNumber(a.position) ?? Number.MAX_SAFE_INTEGER) - (toNumber(b.position) ?? Number.MAX_SAFE_INTEGER),
    )
    result.set(
      key,
      list.map((p) => p.photo_url as string),
    )
  }
  return result
}

const AMENITY_COLUMNS: [AmenityKey, keyof PropertyRow][] = [
  ['parking', 'parking'],
  ['mamad', 'mamad'],
  ['balcony', 'balcony'],
  ['elevator', 'elevator'],
  ['furnished', 'furnished'],
  ['terrace', 'terrace'],
  ['garden', 'garden'],
  ['pool', 'pool'],
  ['gym', 'gym'],
  ['seaView', 'sea_view'],
  ['petFriendly', 'pet_friendly'],
]

export class SupabaseLoadError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message)
    this.name = 'SupabaseLoadError'
  }
}

let client: SupabaseClient | null = null

function getClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) {
    throw new SupabaseLoadError(
      'Supabase is not configured.',
      'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in the project variables.',
    )
  }
  client ??= createClient(url, key, { auth: { persistSession: false } })
  return client
}

function toNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeDealType(value: string | null): DealType {
  const v = (value ?? '').toLowerCase()
  return v.includes('rent') || v.includes('השכר') ? 'rent' : 'sale'
}

function normalizeSource(value: string | null): Source {
  const v = (value ?? '').toLowerCase()
  if (v.includes('facebook') || v === 'fb' || v.includes('פייסבוק')) return 'facebook'
  if (v.includes('yad2') || v.includes('יד2') || v.includes('יד 2')) return 'yad2'
  if (v.includes('madlan') || v.includes('מדלן')) return 'madlan'
  return 'other'
}

function minutesSince(...dates: (string | null)[]) {
  for (const d of dates) {
    if (!d) continue
    const t = new Date(d).getTime()
    if (Number.isFinite(t)) return Math.max(0, Math.floor((Date.now() - t) / 60000))
  }
  return Number.MAX_SAFE_INTEGER
}

function describeError(error: { message: string; code?: string }) {
  if (error.code === '42501') {
    return new SupabaseLoadError(
      'Supabase denied read access to the listings.',
      'Grant SELECT to the anon role and add a read policy on "properties" and "property_photos".',
    )
  }
  return new SupabaseLoadError(`Could not load listings from Supabase: ${error.message}`)
}

// The live database currently spells the table and FK "proprety_photos" / "proprety_id".
// Try the intended name first, then fall back so photos load either way.
async function fetchPhotoRows(supabase: SupabaseClient) {
  const primary = await supabase
    .from(PHOTOS_TABLE)
    .select('id, property_id, photo_url, position')
    .limit(MAX_ROWS * 10)
  if (!primary.error || primary.error.code !== 'PGRST205') return primary
  return supabase
    .from(LEGACY_PHOTOS_TABLE)
    .select('id, property_id:proprety_id, photo_url, position')
    .limit(MAX_ROWS * 10)
}

export async function fetchListings(): Promise<Listing[]> {
  const supabase = getClient()

  const [propertiesRes, photosRes] = await Promise.all([
    supabase
      .from('properties')
      .select('*')
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(MAX_ROWS),
    fetchPhotoRows(supabase),
  ])

  if (propertiesRes.error) throw describeError(propertiesRes.error)

  // Photos are non-critical: a failed photo query should still render the properties.
  if (photosRes.error) {
    console.warn(`Could not load ${PHOTOS_TABLE}; showing properties without photos.`, photosRes.error.message)
  }
  const photosByProperty = groupPhotosByProperty(photosRes.error ? [] : ((photosRes.data ?? []) as PhotoRow[]))

  return ((propertiesRes.data ?? []) as PropertyRow[]).map((row) => {
    const id = String(row.id)
    return {
      id,
      title: row.title ?? '',
      dealType: normalizeDealType(row.transaction_type),
      price: toNumber(row.price) ?? 0,
      city: row.city ?? '',
      neighborhood: row.neighborhood ?? '',
      street: row.street ?? '',
      rooms: toNumber(row.rooms) ?? 0,
      surface: toNumber(row.surface_m2) ?? 0,
      floor: toNumber(row.floor),
      propertyType: row.property_type ?? '',
      amenities: AMENITY_COLUMNS.filter(([, column]) => row[column] === true).map(([key]) => key),
      phone: row.phone ?? '',
      source: normalizeSource(row.source),
      url: row.source_url ?? '',
      publishedMinutesAgo: minutesSince(row.published_at, row.created_at),
      photos: photosByProperty.get(id) ?? [],
      image: photosByProperty.get(id)?.[0] ?? null,
    }
  })
}
