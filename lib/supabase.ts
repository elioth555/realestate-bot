import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { AMENITY_KEYS, type AmenityKey, type Listing } from './listings'
import { dedupeFacebookListings } from './facebook-dedupe'
import { dedupeAcrossSources } from './cross-source-dedupe'
import { fetchAllPages, type PageResult } from './paginate'
import type { CoverageRun } from './freshness'
import { COVERAGE_RUN_COLUMNS, resolveCardFreshness, withFreshness } from './listing-freshness'
import { mapFacebookItem } from './facebook-mapper'
import { resolveCardFirstSeen } from './saved-searches'
import { CANONICAL_CITY, isCanonicalCity } from './geo/canonical-neighborhoods'
import { resolveNeighborhood } from './geo/resolve-neighborhood'
import { deriveFeatures } from './matching/features'
import {
  normalizeCity,
  normalizeDealType,
  normalizeNeighborhood,
  normalizePropertyType,
  normalizeSource,
} from './normalize'

const PHOTOS_TABLE = 'property_photos'

/**
 * Read-time neighborhood resolution; the stored raw `neighborhood` is never rewritten.
 * Tel Aviv rows (and Facebook rows with no city, which come from Tel Aviv groups) resolve into the
 * canonical zones; unresolved rows get an empty neighborhood rather than a raw source name.
 */
function resolveLocation(
  row: { city: string | null; neighborhood: string | null; street: string | null; description?: string | null; title?: string | null },
  source: Listing['source'],
) {
  const city = normalizeCity(row.city)
  if (city && !isCanonicalCity(city)) return { city, neighborhood: normalizeNeighborhood(row.neighborhood) }
  const { neighborhood } = resolveNeighborhood({
    street: row.street,
    sourceNeighborhood: row.neighborhood,
    text: source === 'facebook' ? [row.title, row.description].filter(Boolean).join('\n') : null,
  })
  return { city: city || (neighborhood ? CANONICAL_CITY : ''), neighborhood: neighborhood ?? '' }
}
const LEGACY_PHOTOS_TABLE = 'proprety_photos'
const PROPERTY_PAGE_SIZE = 1000
const MAX_PROPERTY_PAGES = 50

export type PropertyRow = {
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
  first_seen_at?: string | null
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
  hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'SupabaseLoadError'
    this.hint = hint
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

// "published_at" is not unique, so "id" breaks ties; otherwise rows could shift between pages.
async function fetchAllPropertyRows(supabase: SupabaseClient) {
  const { rows, error } = await fetchAllPages<PropertyRow>(
    (from, to) =>
      supabase
        .from('properties')
        .select('*')
        .order('published_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .range(from, to) as unknown as PromiseLike<PageResult<PropertyRow>>,
    { pageSize: PROPERTY_PAGE_SIZE, maxPages: MAX_PROPERTY_PAGES, keyOf: (row) => String((row as PropertyRow).id) },
  )
  return { data: rows, error }
}

export async function fetchListings(): Promise<Listing[]> {
  const supabase = getClient()

  const [propertiesRes, photosRes, runsRes] = await Promise.all([
    fetchAllPropertyRows(supabase),
    fetchPhotoRows(supabase),
    fetchCoverageRuns(supabase),
  ])

  if (propertiesRes.error) throw describeError(propertiesRes.error as Parameters<typeof describeError>[0])

  // Photos are non-critical: a failed photo query should still render the properties.
  if (photosRes.error) {
    console.warn(`Could not load ${PHOTOS_TABLE}; showing properties without photos.`, photosRes.error.message)
  }
  const photosByProperty = groupPhotosByProperty(photosRes.error ? [] : photosRes.data)

  const diagnosticPhotos = photosByProperty.get('24') ?? []
  console.log(
    `[v0] photo diagnostics: property 24 -> ${diagnosticPhotos.length} photos, first: ${diagnosticPhotos[0] ?? 'none'} (total photo rows: ${photosRes.data.length}, properties with photos: ${photosByProperty.size})`,
  )

  // Freshness is display-only: a failed run-history read leaves every listing visible with no status.
  if (runsRes.error) {
    console.warn('Could not load source_refresh_runs; showing listings without freshness status.', runsRes.error.message)
  }
  const now = new Date()
  const sourceListings = ((propertiesRes.data ?? []) as PropertyRow[]).map((row) => {
    const listing = rowToListing(row, photosByProperty.get(String(row.id)) ?? [])
    return runsRes.error ? listing : withFreshness(listing, row, runsRes.data, now)
  })

  const cards = dedupeAcrossSources(dedupeFacebookListings(sourceListings))
  return resolveCardFirstSeen(resolveCardFreshness(cards, sourceListings), sourceListings)
}

async function fetchCoverageRuns(supabase: SupabaseClient) {
  const { rows, error } = await fetchAllPages<CoverageRun>(
    (from, to) =>
      supabase
        .from('source_refresh_runs')
        .select(COVERAGE_RUN_COLUMNS)
        .eq('status', 'succeeded')
        .eq('truncated', false)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<CoverageRun>>,
    { pageSize: PROPERTY_PAGE_SIZE, maxPages: MAX_PROPERTY_PAGES },
  )
  return { data: rows, error }
}

function firstValidDate(...dates: (string | null | undefined)[]) {
  for (const d of dates) {
    if (d && Number.isFinite(new Date(d).getTime())) return d
  }
  return null
}

/**
 * Facebook rows are re-parsed from their stored post text on every read, so parser fixes reach old rows
 * without rewriting Supabase. Stored Facebook values came from older versions of this same parser, so the
 * re-parsed street always wins and re-parsed numbers win when found (stored "ארנונה 635" prices, etc.);
 * the stored value is only a fallback. The re-parsed transaction type also wins when the text is decisive,
 * so Rent/Sale filtering never runs on an older parser's guess. Phone and city keep the stored value.
 */
/**
 * Used only when the post text states no deal type: an older parser's stored guess is overridden when the
 * price makes it impossible (no Tel Aviv rental costs ₪400,000+/month, no sale costs under ₪30,000).
 */
export function dealTypeConsistentWithPrice(stored: string | null, price: number | null): string | null {
  const deal = normalizeDealType(stored)
  if (price === null || price <= 0) return stored
  if (deal === 'rent' && price >= 400_000) return 'sale'
  if (deal === 'sale' && price < 30_000) return 'rent'
  return stored
}

function reparseFacebookRow(row: PropertyRow): PropertyRow {
  if (!row.description?.trim()) return row
  const parsed = mapFacebookItem({ text: row.description, url: row.source_url }).property
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const price = num(parsed.price) ?? toNumber(row.price)
  return {
    ...row,
    street: str(parsed.street),
    city: row.city ?? str(parsed.city),
    transaction_type: str(parsed.transaction_type) ?? dealTypeConsistentWithPrice(row.transaction_type, price),
    price,
    rooms: num(parsed.rooms) ?? toNumber(row.rooms),
    surface_m2: num(parsed.surface_m2) ?? toNumber(row.surface_m2),
    floor: num(parsed.floor) ?? toNumber(row.floor),
    phone: row.phone?.trim() || str(parsed.phone),
  }
}

export function rowToListing(storedRow: PropertyRow, photos: string[] = []): Listing {
  const row = normalizeSource(storedRow.source) === 'facebook' ? reparseFacebookRow(storedRow) : storedRow
  const price = toNumber(row.price)
  const rooms = toNumber(row.rooms)
  const surface = toNumber(row.surface_m2)
  const source = normalizeSource(row.source)
  // Raw columns are never rewritten; tri-state features are derived here on every load.
  // Yad2 stores unticked checkboxes as false, which means "not declared" rather than "does not exist".
  const derived = deriveFeatures({
    flags: Object.fromEntries(AMENITY_COLUMNS.map(([key, column]) => [key, row[column] as boolean | null])),
    flagSemantics: source === 'yad2' ? 'positive-only' : 'explicit',
    protectedSpaceFlagType: 'mamad',
    texts: [row.title, row.description],
    availableFrom: row.available_from,
  })
  const location = resolveLocation(row, source)
  return {
    id: String(row.id),
    title: row.title ?? '',
    description: row.description?.trim() ?? '',
    dealType: normalizeDealType(row.transaction_type),
    price: price ?? 0,
    ...location,
    // Every configured Facebook group is a Tel Aviv group, so a post with no detected city is a Tel Aviv post.
    city: location.city || (source === 'facebook' ? CANONICAL_CITY : ''),
    street: row.street ?? '',
    rooms: rooms ?? 0,
    surface: surface ?? 0,
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
    phone: row.phone?.trim() ?? '',
    source,
    url: row.source_url ?? '',
    publishedAt: firstValidDate(row.published_at, row.created_at),
    publishedMinutesAgo: minutesSince(row.published_at, row.created_at),
    firstSeenAt: firstValidDate(row.first_seen_at, row.created_at),
    photos,
    image: photos[0] ?? null,
  }
}
