import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { importFacebookItems } from '@/lib/facebook-import'
import { extractKeyValueStoreId, fetchRunInputSafe } from '@/lib/apify-run-input'
import { buildRefreshRunRow, extractRunMeta, facebookRunScope } from '@/lib/freshness'
import {
  getAdminClient,
  recordRefreshRun,
  upsertPropertyBySourceUrl,
  type RecordRunResult,
} from '@/lib/upsert-property'
import { replacePropertyPhotos, resolvePhotoTable } from '@/lib/yad2-photos'
import { facebookPhotoFolder, mirrorFacebookPhotos, supabasePhotoStorage } from '@/lib/facebook-photos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DATASET_ID_PATTERN = /^[A-Za-z0-9_~-]+$/

function jsonError(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status })
}

function tokensMatch(provided: string, expected: string) {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function extractRunInfo(payload: unknown) {
  if (!payload || typeof payload !== 'object') return { datasetId: null, eventType: null, status: null }
  const body = payload as Record<string, unknown>
  const resource = (body.resource && typeof body.resource === 'object' ? body.resource : {}) as Record<string, unknown>
  const datasetId = resource.defaultDatasetId ?? body.defaultDatasetId
  return {
    datasetId: typeof datasetId === 'string' ? datasetId.trim() : null,
    eventType: typeof body.eventType === 'string' ? body.eventType : null,
    status: typeof resource.status === 'string' ? resource.status : null,
  }
}

async function fetchDatasetItems(datasetId: string, token: string): Promise<unknown[]> {
  const url = new URL(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items`)
  url.searchParams.set('format', 'json')
  url.searchParams.set('clean', 'true')

  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Apify dataset request failed with HTTP ${res.status}.`)
  const data: unknown = await res.json()
  if (!Array.isArray(data)) throw new Error('Apify dataset response was not a JSON array.')
  return data
}

export async function POST(request: Request) {
  const expectedSecret = process.env.APIFY_FACEBOOK_WEBHOOK_SECRET?.trim()
  if (!expectedSecret) {
    return jsonError(500, 'Webhook is not configured (APIFY_FACEBOOK_WEBHOOK_SECRET is missing).')
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!providedSecret || !tokensMatch(providedSecret, expectedSecret)) {
    return jsonError(401, 'Unauthorized.')
  }

  const apifyToken = process.env.APIFY_API_TOKEN?.trim()
  if (!apifyToken) return jsonError(500, 'Webhook is not configured (APIFY_API_TOKEN is missing).')

  const supabase = getAdminClient()
  if (!supabase) return jsonError(500, 'Webhook is not configured (Supabase URL or secret key is missing).')

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return jsonError(400, 'Request body must be valid JSON.')
  }

  const { datasetId, eventType, status } = extractRunInfo(payload)

  // Acknowledge non-success events with 2xx so Apify does not keep retrying them.
  if ((eventType && eventType !== 'ACTOR.RUN.SUCCEEDED') || (status && status !== 'SUCCEEDED')) {
    return NextResponse.json({ success: true, skipped: true, reason: `Ignored event ${eventType ?? status}.` })
  }

  if (!datasetId || !DATASET_ID_PATTERN.test(datasetId)) {
    return jsonError(400, 'Missing or invalid resource.defaultDatasetId in webhook payload.')
  }

  let items: unknown[]
  try {
    items = await fetchDatasetItems(datasetId, apifyToken)
  } catch (error) {
    console.error('apify-facebook-webhook: dataset fetch failed', error)
    return jsonError(502, error instanceof Error ? error.message : 'Failed to fetch Apify dataset.')
  }

  const meta = extractRunMeta(payload)
  const seenAt = meta.finishedAt ?? new Date().toISOString()
  const runInput = await fetchRunInputSafe(extractKeyValueStoreId(payload), apifyToken)

  const photoTablePromise = resolvePhotoTable(supabase)
  const photoStorage = supabasePhotoStorage(supabase)
  const summary = await importFacebookItems(items, {
    upsert: (property) => upsertPropertyBySourceUrl(supabase, property, { seenAt }),
    syncPhotos: async (propertyId, urls, post) => {
      const photoTable = await photoTablePromise
      if (!photoTable) return { inserted: 0, errors: ['No photo table found (property_photos / proprety_photos).'] }
      const mirrored = await mirrorFacebookPhotos(facebookPhotoFolder(post.postId, post.sourceUrl), urls, photoStorage)
      // Existing photo rows are only replaced once at least one permanent copy exists.
      const saved = await replacePropertyPhotos(supabase, photoTable, propertyId, mirrored.publicUrls)
      return { inserted: saved.inserted, errors: [...mirrored.errors, ...saved.errors] }
    },
  })

  // Recorded only after every item was processed. Group windows bound coverage, so the scan is never "truncated".
  let refreshRun: RecordRunResult = { recorded: false, reason: 'No Apify run id in the webhook payload.' }
  const scope = facebookRunScope(runInput, items)
  if (meta.runId && !scope) refreshRun = { recorded: false, reason: 'Run input could not be read.' }
  if (meta.runId && scope) {
    const row = buildRefreshRunRow({
      source: 'facebook',
      meta: { ...meta, runId: meta.runId },
      scope,
      seenAt,
      itemCount: items.length,
      itemsImported: summary.created + summary.updated,
      itemsFailed: summary.failed,
      truncated: false,
    })
    refreshRun = await recordRefreshRun(supabase, row)
    if (refreshRun.error) console.error('apify-facebook-webhook: refresh run not recorded', refreshRun.error)
    if (scope.problems.length > 0) refreshRun.reason = scope.problems.join(' ')
  }

  // No extras column exists in `properties`; extras are returned in the response for inspection only.
  return NextResponse.json({ success: true, dataset_id: datasetId, refresh_run: refreshRun, ...summary })
}
