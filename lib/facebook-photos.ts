import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Facebook CDN image URLs are signed and expire after ~4 days, so they are never stored.
 * Each image is downloaded at import time and copied into Supabase Storage; only the
 * permanent Storage URL is written to the photos table.
 */

export const FACEBOOK_PHOTO_BUCKET = 'facebook-property-photos'
export const MAX_FACEBOOK_PHOTOS = 10
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 15_000

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Only Facebook's CDN is fetched; anything else is rejected to avoid server-side requests to arbitrary hosts. */
function isAllowedHost(hostname: string) {
  const host = hostname.toLowerCase()
  return host === 'fbcdn.net' || host.endsWith('.fbcdn.net')
}

export function toAllowedImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!isAllowedHost(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

/** The same picture can come back with different signatures, so identity is the URL without its query string. */
function imageIdentity(url: string) {
  const parsed = new URL(url)
  return `${parsed.hostname}${parsed.pathname}`
}

export type ExtractedImages = { urls: string[]; rejected: string[] }

/** Ordered, de-duplicated images from a raw actor item (`images`, falling back to `imageUrl`). */
export function extractFacebookImageUrls(item: unknown): ExtractedImages {
  if (!item || typeof item !== 'object') return { urls: [], rejected: [] }
  const record = item as Record<string, unknown>
  const raw = Array.isArray(record.images) ? record.images : record.imageUrl != null ? [record.imageUrl] : []

  const seen = new Set<string>()
  const urls: string[] = []
  const rejected: string[] = []
  for (const entry of raw) {
    const url = toAllowedImageUrl(entry)
    if (!url) {
      rejected.push(typeof entry === 'string' ? entry : JSON.stringify(entry))
      continue
    }
    const id = imageIdentity(url)
    if (seen.has(id)) continue
    seen.add(id)
    urls.push(url)
    if (urls.length >= MAX_FACEBOOK_PHOTOS) break
  }
  return { urls, rejected }
}

/** Safe folder name for a post: the Facebook post id when it is clean, otherwise a hash of the post URL. */
export function facebookPhotoFolder(postId: string | null, sourceUrl: string | null) {
  if (postId && /^[A-Za-z0-9_-]{1,80}$/.test(postId)) return `facebook/${postId}`
  const key = postId ?? sourceUrl ?? 'unknown'
  return `facebook/h-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

export type DownloadedImage = { bytes: Uint8Array; contentType: string; extension: string }

async function readCapped(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new Error(`Image is larger than ${limit} bytes.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function downloadImage(
  url: string,
  fetchImpl: typeof fetch = fetch,
  { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES } = {},
): Promise<DownloadedImage> {
  if (!toAllowedImageUrl(url)) throw new Error('URL is not an allowed Facebook image URL.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Redirects are refused so the host allow-list cannot be bypassed.
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'error', cache: 'no-store' })
    if (!res.ok) {
      throw new Error(res.status === 403 ? 'HTTP 403 (Facebook URL signature likely expired).' : `HTTP ${res.status}.`)
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const extension = CONTENT_TYPE_EXTENSIONS[contentType]
    if (!extension) throw new Error(`Not an image (content-type "${contentType || 'missing'}").`)

    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Image is larger than ${maxBytes} bytes.`)
    if (!res.body) throw new Error('Empty response body.')

    const bytes = await readCapped(res.body, maxBytes)
    if (bytes.byteLength === 0) throw new Error('Empty image.')
    return { bytes, contentType, extension }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs} ms.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Storage I/O behind an interface so the mirroring logic is testable offline. */
export type PhotoStorage = {
  /** Uploads (overwriting) and returns the permanent public URL. */
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<string>
  list: (folder: string) => Promise<string[]>
  remove: (paths: string[]) => Promise<void>
}

export type MirrorResult = { publicUrls: string[]; errors: string[] }

/**
 * Downloads and stores each image as `{folder}/{position}.{ext}`. Positions follow the
 * post's image order, so re-importing the same post overwrites the same files instead of
 * adding new ones. A failed image is reported and skipped; it never fails the listing.
 */
export async function mirrorFacebookPhotos(
  folder: string,
  urls: string[],
  storage: PhotoStorage,
  fetchImpl: typeof fetch = fetch,
): Promise<MirrorResult> {
  const results = await Promise.all(
    urls.map(async (url, position) => {
      try {
        const image = await downloadImage(url, fetchImpl)
        const path = `${folder}/${position}.${image.extension}`
        const publicUrl = await storage.upload(path, image.bytes, image.contentType)
        return { ok: true as const, path, publicUrl }
      } catch (error) {
        return { ok: false as const, error: `image ${position}: ${error instanceof Error ? error.message : 'Unknown error.'}` }
      }
    }),
  )

  const publicUrls: string[] = []
  const keptPaths = new Set<string>()
  const errors: string[] = []
  for (const result of results) {
    if (result.ok) {
      publicUrls.push(result.publicUrl)
      keptPaths.add(result.path)
    } else {
      errors.push(result.error)
    }
  }

  // Remove files left from an earlier import that had more images, but only once this import produced a full set.
  if (publicUrls.length > 0 && errors.length === 0) {
    try {
      const existing = await storage.list(folder)
      const stale = existing.map((name) => `${folder}/${name}`).filter((path) => !keptPaths.has(path))
      if (stale.length > 0) await storage.remove(stale)
    } catch (error) {
      errors.push(`cleanup: ${error instanceof Error ? error.message : 'Unknown error.'}`)
    }
  }

  return { publicUrls, errors }
}

let bucketReady: Promise<void> | null = null

/** Creates the public bucket on first use if it does not exist yet. Images only, size-capped. */
export function ensureFacebookPhotoBucket(supabase: SupabaseClient): Promise<void> {
  bucketReady ??= (async () => {
    const existing = await supabase.storage.getBucket(FACEBOOK_PHOTO_BUCKET)
    if (!existing.error && existing.data) return
    const created = await supabase.storage.createBucket(FACEBOOK_PHOTO_BUCKET, {
      public: true,
      fileSizeLimit: MAX_IMAGE_BYTES,
      allowedMimeTypes: Object.keys(CONTENT_TYPE_EXTENSIONS),
    })
    if (created.error && !/already exists/i.test(created.error.message)) {
      throw new Error(`Could not create bucket "${FACEBOOK_PHOTO_BUCKET}": ${created.error.message}`)
    }
  })().catch((error) => {
    bucketReady = null
    throw error
  })
  return bucketReady
}

export function supabasePhotoStorage(supabase: SupabaseClient): PhotoStorage {
  const bucket = () => supabase.storage.from(FACEBOOK_PHOTO_BUCKET)
  return {
    async upload(path, bytes, contentType) {
      await ensureFacebookPhotoBucket(supabase)
      const { error } = await bucket().upload(path, bytes, { contentType, upsert: true, cacheControl: '604800' })
      if (error) throw new Error(`Upload failed: ${error.message}`)
      return bucket().getPublicUrl(path).data.publicUrl
    },
    async list(folder) {
      const { data, error } = await bucket().list(folder, { limit: 100 })
      if (error) throw new Error(`List failed: ${error.message}`)
      return (data ?? []).map((entry) => entry.name)
    },
    async remove(paths) {
      const { error } = await bucket().remove(paths)
      if (error) throw new Error(`Remove failed: ${error.message}`)
    },
  }
}
