import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { validatePropertyInput } from '@/lib/import-listing'
import { getAdminClient, upsertPropertyBySourceUrl } from '@/lib/upsert-property'
import { mapYad2Item, type Yad2Item } from '@/lib/yad2-mapper'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const CONCURRENCY = 5
const DATASET_ID_PATTERN = /^[A-Za-z0-9_~-]+$/

type ImportError = { index: number; item_id: string | null; source_url: string | null; errors: string[] }

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

async function fetchDatasetItems(datasetId: string): Promise<Yad2Item[]> {
  const url = new URL(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items`)
  url.searchParams.set('format', 'json')

  const headers: HeadersInit = { Accept: 'application/json' }
  const apifyToken = process.env.APIFY_API_TOKEN
  if (apifyToken) headers.Authorization = `Bearer ${apifyToken}`

  const res = await fetch(url, { headers, cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`Apify dataset request failed with HTTP ${res.status}.`)
  }
  const data: unknown = await res.json()
  if (!Array.isArray(data)) throw new Error('Apify dataset response was not a JSON array.')
  return data.filter((item): item is Yad2Item => !!item && typeof item === 'object' && !Array.isArray(item))
}

export async function POST(request: Request) {
  const expectedSecret = process.env.APIFY_WEBHOOK_SECRET
  if (!expectedSecret) {
    return jsonError(500, 'Webhook is not configured (APIFY_WEBHOOK_SECRET is missing).')
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const providedSecret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!providedSecret || !tokensMatch(providedSecret, expectedSecret)) {
    return jsonError(401, 'Unauthorized.')
  }

  const supabase = getAdminClient()
  if (!supabase) {
    return jsonError(500, 'Webhook is not configured (Supabase URL or secret key is missing).')
  }

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

  let items: Yad2Item[]
  try {
    items = await fetchDatasetItems(datasetId)
  } catch (error) {
    console.error('apify-yad2-webhook: dataset fetch failed', error)
    return jsonError(502, error instanceof Error ? error.message : 'Failed to fetch Apify dataset.')
  }

  let created = 0
  let updated = 0
  const errors: ImportError[] = []

  async function importItem(item: Yad2Item, index: number) {
    const mapped = mapYad2Item(item)
    const itemId = item.item_id == null ? null : String(item.item_id)
    const sourceUrl = typeof mapped.source_url === 'string' ? mapped.source_url : null

    const validation = validatePropertyInput(mapped)
    if (!validation.ok) {
      errors.push({ index, item_id: itemId, source_url: sourceUrl, errors: validation.errors })
      return
    }

    try {
      const result = await upsertPropertyBySourceUrl(supabase!, validation.data)
      if (!result.ok) {
        errors.push({ index, item_id: itemId, source_url: sourceUrl, errors: [result.error] })
      } else if (result.action === 'created') {
        created++
      } else {
        updated++
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

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map((item, j) => importItem(item, i + j)))
  }

  errors.sort((a, b) => a.index - b.index)

  return NextResponse.json({
    success: true,
    dataset_id: datasetId,
    total: items.length,
    created,
    updated,
    failed: errors.length,
    errors,
  })
}
