import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { AMENITY_KEYS, type AmenityKey, type Listing } from './listings'
import { deriveFeatures } from './matching/features'
import {
  normalizeCity,
  normalizeDealType,
  normalizeNeighborhood,
  normalizePropertyType,
  normalizeSource,
} from './normalize'

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
  description?: string | null
  available_from?: string | null
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

const PHOTO_PAGE_SIZE = 1000
const MAX_PHOTO_PAGES = 50

type RawPhotoRow = Record<string, unknown>

function normalizePhotoRow(row: RawPhotoRow): PhotoRow | null {
  const propertyId = row.property_id ?? row.proprety_id
  if (propertyId === null || propertyId === undefined || propertyId === '') return null
  return {
    id: row.id as string | number,
    property_id: propertyId as string | number,
    photo_url: typeof row.photo_url === 'string' ? row.photo_url.trim() : null,
    position: row.position as number | string | null,
  }
}

// PostgREST caps each response at its max-rows setting (1000 by default) regardless of .limit(),
// so page through the table explicitly to get every photo row.
async function fetchAllRows(supabase: SupabaseClient, table: string) {
  const rows: RawPhotoRow[] = []
  for (let page = 0; page < MAX_PHOTO_PAGES; page++) {
    const from = page * PHOTO_PAGE_SIZE
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + PHOTO_PAGE_SIZE - 1)
    if (error) return { rows, error }
    rows.push(...((data ?? []) as RawPhotoRow[]))
    if (!data || data.length < PHOTO_PAGE_SIZE) break
  }
  return { rows, error: null }
}

// Selecting "*" and normalizing in JS tolerates both FK spellings (property_id / proprety_id).
// Both table names are queried because the API currently exposes the legacy "proprety_photos" name.
async function fetchPhotoRows(supabase: SupabaseClient) {
  const results = await Promise.all([PHOTOS_TABLE, LEGACY_PHOTOS_TABLE].map((t) => fetchAllRows(supabase, t)))
  const available = results.filter((r) => !r.error)
  if (available.length === 0) return { data: [] as PhotoRow[], error: results[0].error }

  const seen = new Set<string>()
  const data: PhotoRow[] = []
  for (const { rows } of available) {
    for (const raw of rows) {
      const row = normalizePhotoRow(raw)
      if (!row?.photo_url) continue
      const key = `${row.property_id}|${row.photo_url}`
      if (seen.has(key)) continue
      seen.add(key)
      data.push(row)
    }
  }
  return { data, error: null }
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
  const photosByProperty = groupPhotosByProperty(photosRes.error ? [] : photosRes.data)

  const diagnosticPhotos = photosByProperty.get('24') ?? []
  console.log(
    `[v0] photo diagnostics: property 24 -> ${diagnosticPhotos.length} photos, first: ${diagnosticPhotos[0] ?? 'none'} (total photo rows: ${photosRes.data.length}, properties with photos: ${photosByProperty.size})`,
  )

  return ((propertiesRes.data ?? []) as PropertyRow[]).map((row) => {
    const id = String(row.id)
    const price = toNumber(row.price)
    const rooms = toNumber(row.rooms)
    const surface = toNumber(row.surface_m2)
    // Raw columns are never rewritten; tri-state features are derived here on every load.
    const derived = deriveFeatures({
      flags: Object.fromEntries(AMENITY_COLUMNS.map(([key, column]) => [key, row[column] as boolean | null])),
      protectedSpaceFlagType: 'mamad',
      texts: [row.title, row.description],
      availableFrom: row.available_from,
    })
    return {
      id,
      title: row.title ?? '',
      dealType: normalizeDealType(row.transaction_type),
      price: toNumber(row.price) ?? 0,
      city: normalizeCity(row.city),
      neighborhood: normalizeNeighborhood(row.neighborhood),
      street: row.street ?? '',
      rooms: toNumber(row.rooms) ?? 0,
      surface: toNumber(row.surface_m2) ?? 0,
      floor: toNumber(row.floor),
      propertyType: normalizePropertyType(row.property_type),
      amenities: AMENITY_KEYS.filter((key) => derived.features[key] === 'yes'),
      features: derived.features,
      protectedSpaceType: derived.protectedSpaceType,
      entryDate: derived.entryDate,
      known: {
        price: price !== null && price > 0,
        rooms: rooms !== null && rooms > 0,
        surface: surface !== null && surface > 0,
      },
      phone: row.phone ?? '',
      source: normalizeSource(row.source),
      url: row.source_url ?? '',
      publishedMinutesAgo: minutesSince(row.published_at, row.created_at),
      photos: photosByProperty.get(id) ?? [],
      image: photosByProperty.get(id)?.[0] ?? null,
    }
  })
}
