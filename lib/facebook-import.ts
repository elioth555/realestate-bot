import { validatePropertyInput, type PropertyInput } from '@/lib/import-listing'
import { mapFacebookItem, type FacebookExtras, type FacebookItem } from '@/lib/facebook-mapper'
import type { UpsertResult } from '@/lib/upsert-property'

export type FacebookImportError = { index: number; post_id: string | null; source_url: string | null; errors: string[] }
export type FacebookSkip = { index: number; post_id: string | null; source_url: string | null; reason: string }

/** I/O kept behind this interface so the import loop can be tested offline with fakes. */
export type FacebookImportDeps = {
  upsert: (property: PropertyInput & { source_url: string }) => Promise<UpsertResult>
  /** Unused while the actor returns no photo URLs; kept so photos plug in later without touching the loop. */
  syncPhotos?: (propertyId: string | number, urls: string[]) => Promise<{ inserted: number; errors: string[] }>
  concurrency?: number
}

export type FacebookImportSummary = {
  total: number
  created: number
  updated: number
  skipped: number
  failed: number
  photos_inserted: number
  errors: FacebookImportError[]
  skips: FacebookSkip[]
  photo_errors: { post_id: string | null; property_id: string | number; errors: string[] }[]
  /**
   * Extras have no column in `properties`, so they are returned here (and logged) rather than stored.
   * Keyed by source_url for imported posts only.
   */
  extras: Record<string, FacebookExtras>
}

/**
 * Map → skip seekers → validate (Facebook rules: price optional) → upsert by source_url.
 * One failing item never stops the rest.
 */
export async function importFacebookItems(items: unknown[], deps: FacebookImportDeps): Promise<FacebookImportSummary> {
  const concurrency = Math.max(1, deps.concurrency ?? 5)
  let created = 0
  let updated = 0
  let photosInserted = 0
  const errors: FacebookImportError[] = []
  const skips: FacebookSkip[] = []
  const photoErrors: FacebookImportSummary['photo_errors'] = []
  const extrasByUrl: Record<string, FacebookExtras> = {}

  async function importItem(raw: unknown, index: number) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ index, post_id: null, source_url: null, errors: ['Dataset item is not an object.'] })
      return
    }

    let postId: string | null = null
    let sourceUrl: string | null = null
    try {
      const { property, photoUrls, extras } = mapFacebookItem(raw as FacebookItem)
      postId = extras.fb_post_id
      sourceUrl = typeof property.source_url === 'string' ? property.source_url : null

      if (extras.post_intent === 'seeking') {
        skips.push({ index, post_id: postId, source_url: sourceUrl, reason: 'Seeker post (not a property offer).' })
        return
      }

      const validation = validatePropertyInput(property)
      if (!validation.ok) {
        errors.push({ index, post_id: postId, source_url: sourceUrl, errors: validation.errors })
        return
      }

      const result = await deps.upsert(validation.data)
      if (!result.ok) {
        errors.push({ index, post_id: postId, source_url: sourceUrl, errors: [result.error] })
        return
      }
      if (result.action === 'created') created++
      else updated++
      extrasByUrl[validation.data.source_url] = extras

      if (photoUrls.length === 0 || !deps.syncPhotos) return
      try {
        const photos = await deps.syncPhotos(result.id, photoUrls)
        photosInserted += photos.inserted
        if (photos.errors.length > 0) photoErrors.push({ post_id: postId, property_id: result.id, errors: photos.errors })
      } catch (error) {
        photoErrors.push({
          post_id: postId,
          property_id: result.id,
          errors: [error instanceof Error ? error.message : 'Unknown photo error.'],
        })
      }
    } catch (error) {
      errors.push({
        index,
        post_id: postId,
        source_url: sourceUrl,
        errors: [error instanceof Error ? error.message : 'Unknown error.'],
      })
    }
  }

  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map((item, j) => importItem(item, i + j)))
  }

  errors.sort((a, b) => a.index - b.index)
  skips.sort((a, b) => a.index - b.index)
  return {
    total: items.length,
    created,
    updated,
    skipped: skips.length,
    failed: errors.length,
    photos_inserted: photosInserted,
    errors,
    skips,
    photo_errors: photoErrors,
    extras: extrasByUrl,
  }
}
