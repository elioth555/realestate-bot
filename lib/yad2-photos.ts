import type { SupabaseClient } from '@supabase/supabase-js'
import type { Yad2Item } from '@/lib/yad2-mapper'

const MAX_PHOTOS_PER_LISTING = 50
const URL_KEYS = ['url', 'src', 'href', 'image', 'image_url', 'imageUrl']

type PhotoTable = { table: string; fk: string }

// Mirrors the dashboard reader in lib/supabase.ts: the live database spells the
// table/FK "proprety_photos" / "proprety_id", so fall back to it when needed.
const PHOTO_TABLES: PhotoTable[] = [
  { table: 'property_photos', fk: 'property_id' },
  { table: 'proprety_photos', fk: 'proprety_id' },
]

export type PhotoSyncResult = { inserted: number; errors: string[] }

function toHttpUrl(value: unknown): string | null {
  let candidate = value
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const obj = candidate as Record<string, unknown>
    candidate = URL_KEYS.map((k) => obj[k]).find((v) => typeof v === 'string')
  }
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export function extractYad2ImageUrls(item: Yad2Item): { urls: string[]; skipped: number } {
  const raw = item.images
  const entries = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  const seen = new Set<string>()
  let skipped = 0

  for (const entry of entries) {
    const url = toHttpUrl(entry)
    if (!url) {
      skipped++
      continue
    }
    if (!seen.has(url)) seen.add(url)
    if (seen.size >= MAX_PHOTOS_PER_LISTING) break
  }
  return { urls: [...seen], skipped }
}

export async function resolvePhotoTable(supabase: SupabaseClient): Promise<PhotoTable | null> {
  for (const candidate of PHOTO_TABLES) {
    const { error } = await supabase.from(candidate.table).select('id').limit(1)
    if (!error) return candidate
  }
  return null
}

// Replaces a property's photos with the latest image list so repeated runs never duplicate.
// Existing photos are kept untouched when the listing has no usable images.
export async function replacePropertyPhotos(
  supabase: SupabaseClient,
  photoTable: PhotoTable,
  propertyId: string | number,
  urls: string[],
): Promise<PhotoSyncResult> {
  if (urls.length === 0) return { inserted: 0, errors: [] }

  const removed = await supabase.from(photoTable.table).delete().eq(photoTable.fk, propertyId)
  if (removed.error) return { inserted: 0, errors: [`Could not clear old photos: ${removed.error.message}`] }

  const rows = urls.map((photo_url, position) => ({ [photoTable.fk]: propertyId, photo_url, position }))
  const batch = await supabase.from(photoTable.table).insert(rows)
  if (!batch.error) return { inserted: rows.length, errors: [] }

  // Batch failed: insert one by one so a single bad image does not drop the rest.
  let inserted = 0
  const errors: string[] = []
  for (const row of rows) {
    const single = await supabase.from(photoTable.table).insert(row)
    if (single.error) errors.push(`${row.photo_url}: ${single.error.message}`)
    else inserted++
  }
  return { inserted, errors }
}
