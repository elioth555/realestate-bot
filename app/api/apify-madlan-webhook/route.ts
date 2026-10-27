import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { importMadlanItems } from '@/lib/madlan-import'
import { extractKeyValueStoreId, fetchRunInputSafe } from '@/lib/apify-run-input'
import { buildRefreshRunRow, extractRunMeta, madlanRunScope, madlanRunTruncated } from '@/lib/freshness'
import {
  getAdminClient,
  recordRefreshRun,
  upsertPropertyBySourceUrl,
  type RecordRunResult,
} from '@/lib/upsert-property'
import { replacePropertyPhotos, resolvePhotoTable } from '@/lib/yad2-photos'

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

// TEMPORARY: safe auth diagnostics. Exposes only booleans and lengths, never secret characters.
function buildAuthDiagnostics(authHeader: string, envSecret: string) {
  const hasEdgeWhitespace = (value: string) => value.length > 0 && value !== value.trim()
  const startsWithBearer = authHeader.startsWith('Bearer ')
  const rawToken = startsWithBearer ? authHeader.slice(7) : ''
  const trimmedToken = rawToken.trim()

  const firstSpace = authHeader.indexOf(' ')
  const scheme = firstSpace === -1 ? authHeader : authHeader.slice(0, firstSpace)
  const authSchemeDetected = authHeader.length === 0 ? 'none' : scheme === 'Bearer' ? 'Bearer' : 'other'
  const splitParts = firstSpace === -1 ? [authHeader] : [scheme, authHeader.slice(firstSpace + 1)]

  return {
    envExists: envSecret.length > 0,
    envSecretLength: envSecret.length,
    authHeaderExists: authHeader.length > 0,
    authHeaderLength: authHeader.length,
    authSchemeDetected,
    authSchemeCaseInsensitiveBearer: scheme.toLowerCase() === 'bearer',
    headerContainsSpace: firstSpace !== -1,
    splitOnFirstSpaceGivesTwoParts: splitParts.length === 2 && splitParts[0].length > 0 && splitParts[1].length > 0,
    startsWithBearer,
    extractedTokenLength: rawToken.length,
    exactMatch: rawToken.length > 0 && tokensMatch(rawToken, envSecret),
    trimmedMatch: trimmedToken.length > 0 && tokensMatch(trimmedToken, envSecret.trim()),
    envHadLeadingOrTrailingWhitespace: hasEdgeWhitespace(envSecret),
    tokenHadLeadingOrTrailingWhitespace: hasEdgeWhitespace(rawToken),
  }
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
  const expectedSecret = process.env.APIFY_MADLAN_WEBHOOK_SECRET
  if (!expectedSecret) {
    return jsonError(500, 'Webhook is not configured (APIFY_MADLAN_WEBHOOK_SECRET is missing).')
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!providedSecret || !tokensMatch(providedSecret, expectedSecret)) {
    // TEMPORARY auth diagnostics: booleans and lengths only, never secret characters. Remove once resolved.
    const authDiagnostics = buildAuthDiagnostics(authHeader, expectedSecret)
    console.warn('apify-madlan-webhook: unauthorized', authDiagnostics)
    return NextResponse.json({ success: false, error: 'Unauthorized.', authDiagnostics }, { status: 401 })
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
    console.error('apify-madlan-webhook: dataset fetch failed', error)
    return jsonError(502, error instanceof Error ? error.message : 'Failed to fetch Apify dataset.')
  }

  const meta = extractRunMeta(payload)
  const seenAt = meta.finishedAt ?? new Date().toISOString()
  const runInput = await fetchRunInputSafe(extractKeyValueStoreId(payload), apifyToken)

  const photoTablePromise = resolvePhotoTable(supabase)
  const summary = await importMadlanItems(items, {
    upsert: (property) => upsertPropertyBySourceUrl(supabase, property, { seenAt }),
    syncPhotos: async (propertyId, urls) => {
      const photoTable = await photoTablePromise
      if (!photoTable) return { inserted: 0, errors: ['No photo table found (property_photos / proprety_photos).'] }
      return replacePropertyPhotos(supabase, photoTable, propertyId, urls)
    },
  })

  // Recorded only after every item was processed. Without a run id or readable input there is no scope to record.
  let refreshRun: RecordRunResult = { recorded: false, reason: 'No Apify run id in the webhook payload.' }
  const scope = madlanRunScope(runInput)
  if (meta.runId && !scope) refreshRun = { recorded: false, reason: 'Run input could not be read.' }
  if (meta.runId && scope) {
    const row = buildRefreshRunRow({
      source: 'madlan',
      meta: { ...meta, runId: meta.runId },
      scope,
      seenAt,
      itemCount: items.length,
      itemsImported: summary.created + summary.updated,
      itemsFailed: summary.failed,
      truncated: madlanRunTruncated(items.length, scope.max_items),
    })
    refreshRun = await recordRefreshRun(supabase, row)
    if (refreshRun.error) console.error('apify-madlan-webhook: refresh run not recorded', refreshRun.error)
    if (scope.problems.length > 0) refreshRun.reason = scope.problems.join(' ')
  }

  return NextResponse.json({ success: true, dataset_id: datasetId, refresh_run: refreshRun, ...summary })
}
