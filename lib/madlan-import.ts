import { validatePropertyInput, type PropertyInput } from '@/lib/import-listing'
import { mapMadlanItem, type MadlanItem } from '@/lib/madlan-mapper'
import type { UpsertResult } from '@/lib/upsert-property'

export type MadlanImportError = { index: number; item_id: string | null; source_url: string | null; errors: string[] }
export type MadlanPhotoError = {
  item_id: string | null
  source_url: string | null
  property_id: string | number
  errors: string[]
}

/** I/O kept behind this interface so the import loop can be tested offline with fakes. */
export type MadlanImportDeps = {
  upsert: (property: PropertyInput & { source_url: string }) => Promise<UpsertResult>
  syncPhotos: (propertyId: string | number, urls: string[]) => Promise<{ inserted: number; errors: string[] }>
  concurrency?: number
}

export type MadlanImportSummary = {
  total: number
  created: number
  updated: number
  failed: number
  photos_inserted: number
  errors: MadlanImportError[]
  photo_errors: MadlanPhotoError[]
}

/**
 * Map → validate → upsert by source_url → replace photos, for every dataset item.
 * One failing item or photo never stops the rest; photo failures never mark the listing as failed.
 */
export async function importMadlanItems(items: unknown[], deps: MadlanImportDeps): Promise<MadlanImportSummary> {
  const concurrency = Math.max(1, deps.concurrency ?? 5)
  let created = 0
  let updated = 0
  let photosInserted = 0
  const errors: MadlanImportError[] = []
  const photoErrors: MadlanPhotoError[] = []

  async function importItem(raw: unknown, index: number) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ index, item_id: null, source_url: null, errors: ['Dataset item is not an object.'] })
      return
    }

    let itemId: string | null = null
    let sourceUrl: string | null = null
    try {
      const { property, photoUrls, extras } = mapMadlanItem(raw as MadlanItem)
      itemId = extras.external_id
      sourceUrl = typeof property.source_url === 'string' ? property.source_url : null

      const validation = validatePropertyInput(property)
      if (!validation.ok) {
        errors.push({ index, item_id: itemId, source_url: sourceUrl, errors: validation.errors })
        return
      }

      const result = await deps.upsert(validation.data)
      if (!result.ok) {
        errors.push({ index, item_id: itemId, source_url: sourceUrl, errors: [result.error] })
        return
      }
      if (result.action === 'created') created++
      else updated++

      if (photoUrls.length === 0) return
      try {
        const photos = await deps.syncPhotos(result.id, photoUrls)
        photosInserted += photos.inserted
        if (photos.errors.length > 0) {
          photoErrors.push({ item_id: itemId, source_url: sourceUrl, property_id: result.id, errors: photos.errors })
        }
      } catch (error) {
        photoErrors.push({
          item_id: itemId,
          source_url: sourceUrl,
          property_id: result.id,
          errors: [error instanceof Error ? error.message : 'Unknown photo error.'],
        })
      }
    } catch (error) {
      errors.push({
        index,
        item_id: itemId,
        source_url: sourceUrl,
        errors: [error instanceof Error ? error.message : 'Unknown error.'],
      })
    }
  }

  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map((item, j) => importItem(item, i + j)))
  }

  errors.sort((a, b) => a.index - b.index)
  return {
    total: items.length,
    created,
    updated,
    failed: errors.length,
    photos_inserted: photosInserted,
    errors,
    photo_errors: photoErrors,
  }
}
