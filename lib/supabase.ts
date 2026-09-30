import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AmenityKey, DealType, Listing, Source } from './listings'

// The photos table in the connected database is spelled "proprety_photos"; "property_photos" does not exist.
const PHOTOS_TABLE = 'proprety_photos'
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
  property_id: string | number
  photo_url: string | null
  position: number | null
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
      'Grant SELECT to the anon role and add a read policy on "properties" and "proprety_photos".',
    )
  }
  return new SupabaseLoadError(`Could not load listings from Supabase: ${error.message}`)
}

export async function fetchListings(): Promise<Listing[]> {
  const supabase = getClient()

  const [propertiesRes, photosRes] = await Promise.all([
    supabase
      .from('properties')
      .select('*')
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(MAX_ROWS),
    supabase
      .from(PHOTOS_TABLE)
      .select('property_id, photo_url, position')
      .order('position', { ascending: true })
      .limit(MAX_ROWS * 10),
  ])

  if (propertiesRes.error) throw describeError(propertiesRes.error)
  if (photosRes.error) throw describeError(photosRes.error)

  const firstPhoto = new Map<string, string>()
  for (const photo of (photosRes.data ?? []) as PhotoRow[]) {
    const key = String(photo.property_id)
    if (photo.photo_url && !firstPhoto.has(key)) firstPhoto.set(key, photo.photo_url)
  }

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
      image: firstPhoto.get(id) ?? null,
    }
  })
}
