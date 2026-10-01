import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_PAGES_PER_SEARCH = 1
const MAX_REQUESTS_PER_CRAWL = 50
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_.-]+(~[A-Za-z0-9_.-]+)?$/
const NEIGHBORHOOD_ID_PATTERN = /^\d{1,6}$/

// Old Yad2 URL format known to be accepted by the Apify actor. Only Tel Aviv rentals are supported for now.
const CITY_CONFIG: Record<string, { path: string; params: Record<string, string> }> = {
  'tel aviv': { path: 'rent', params: { topArea: '2', area: '1', city: '5000' } },
}
const SUPPORTED_TRANSACTION_TYPES = ['rent']

type SearchCriteria = {
  cityKey: string
  minRooms: number | null
  maxRooms: number | null
  maxPrice: number | null
  neighborhoodIds: string[]
}

function jsonError(status: number, error: string, details?: string[]) {
  return NextResponse.json({ success: false, error, ...(details ? { details } : {}) }, { status })
}

function tokensMatch(provided: string, expected: string) {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function readOptionalNumber(body: Record<string, unknown>, key: string, errors: string[]) {
  const value = body[key]
  if (value === undefined || value === null || value === '') return null
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    errors.push(`${key} must be a number.`)
    return null
  }
  if (num <= 0) {
    errors.push(`${key} must be greater than 0.`)
    return null
  }
  return num
}

function validateCriteria(input: unknown): { ok: true; data: SearchCriteria } | { ok: false; status: number; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, errors: ['Request body must be a JSON object.'] }
  }
  const body = input as Record<string, unknown>

  const cityKey = typeof body.city === 'string' ? body.city.trim().toLowerCase().replace(/[-_\s]+/g, ' ') : ''
  if (!CITY_CONFIG[cityKey]) {
    return { ok: false, status: 400, errors: [`Unsupported city "${String(body.city ?? '')}". Supported: Tel Aviv.`] }
  }

  const transactionType = typeof body.transaction_type === 'string' ? body.transaction_type.trim().toLowerCase() : ''
  if (!SUPPORTED_TRANSACTION_TYPES.includes(transactionType)) {
    return {
      ok: false,
      status: 400,
      errors: [`Unsupported transaction_type "${String(body.transaction_type ?? '')}". Supported: rent.`],
    }
  }

  const errors: string[] = []
  const minRooms = readOptionalNumber(body, 'min_rooms', errors)
  const maxRooms = readOptionalNumber(body, 'max_rooms', errors)
  const maxPrice = readOptionalNumber(body, 'max_price', errors)

  if (minRooms !== null && minRooms > 20) errors.push('min_rooms must be 20 or less.')
  if (maxRooms !== null && maxRooms > 20) errors.push('max_rooms must be 20 or less.')
  if (minRooms !== null && maxRooms !== null && minRooms > maxRooms) {
    errors.push('min_rooms must be less than or equal to max_rooms.')
  }

  let neighborhoodIds: string[] = []
  if (body.neighborhood_ids !== undefined && body.neighborhood_ids !== null) {
    if (!Array.isArray(body.neighborhood_ids)) {
      errors.push('neighborhood_ids must be an array of numeric strings.')
    } else {
      neighborhoodIds = body.neighborhood_ids.map((id) => String(id).trim())
      if (neighborhoodIds.some((id) => !NEIGHBORHOOD_ID_PATTERN.test(id))) {
        errors.push('neighborhood_ids must contain only numeric IDs.')
      }
    }
  }

  if (errors.length > 0) return { ok: false, status: 400, errors }
  return { ok: true, data: { cityKey, minRooms, maxRooms, maxPrice, neighborhoodIds } }
}

function buildSearchUrl(criteria: SearchCriteria) {
  const config = CITY_CONFIG[criteria.cityKey]
  const url = new URL(`https://www.yad2.co.il/realestate/${config.path}`)
  for (const [key, value] of Object.entries(config.params)) url.searchParams.set(key, value)
  if (criteria.minRooms !== null) url.searchParams.set('minRooms', String(criteria.minRooms))
  if (criteria.maxRooms !== null) url.searchParams.set('maxRooms', String(criteria.maxRooms))
  if (criteria.maxPrice !== null) url.searchParams.set('maxPrice', String(Math.round(criteria.maxPrice)))
  return url.toString()
}

export async function POST(request: Request) {
  const expectedToken = process.env.IMPORT_API_TOKEN
  if (!expectedToken) {
    return jsonError(500, 'Search endpoint is not configured (IMPORT_API_TOKEN is missing).')
  }
  const authHeader = request.headers.get('authorization') ?? ''
  const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!providedToken || !tokensMatch(providedToken, expectedToken)) {
    return jsonError(401, 'Unauthorized.')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Request body must be valid JSON.')
  }

  const validation = validateCriteria(body)
  if (!validation.ok) return jsonError(validation.status, 'Validation failed.', validation.errors)
  const criteria = validation.data

  const apifyToken = process.env.APIFY_API_TOKEN?.trim()
  const actorId = process.env.APIFY_YAD2_ACTOR_ID?.trim().replace('/', '~')
  if (!apifyToken) return jsonError(500, 'Search endpoint is not configured (APIFY_API_TOKEN is missing).')
  if (!actorId || !ACTOR_ID_PATTERN.test(actorId)) {
    return jsonError(500, 'Search endpoint is not configured (APIFY_YAD2_ACTOR_ID is missing or invalid).')
  }

  const searchUrl = buildSearchUrl(criteria)
  const actorInput = {
    startUrls: [{ url: searchUrl }],
    maxPagesPerSearch: MAX_PAGES_PER_SEARCH,
    maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL,
  }

  let apifyResponse: Response
  try {
    apifyResponse = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apifyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(actorInput),
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    console.error('yad2-search: Apify request failed', error)
    return jsonError(502, 'Could not reach the Apify API.')
  }

  const result = (await apifyResponse.json().catch(() => null)) as
    | { data?: { id?: string; status?: string }; error?: { type?: string; message?: string } }
    | null

  if (!apifyResponse.ok || !result?.data?.id) {
    const message = result?.error?.message ?? `Apify returned HTTP ${apifyResponse.status}.`
    console.error('yad2-search: Apify rejected the run', apifyResponse.status, result?.error)
    return jsonError(502, 'Failed to start the Apify actor.', [message])
  }

  return NextResponse.json(
    {
      success: true,
      run_id: result.data.id,
      status: result.data.status ?? 'READY',
      search_url: searchUrl,
      neighborhood_filter_applied: false,
      ...(criteria.neighborhoodIds.length > 0
        ? {
            neighborhood_filter_note:
              'neighborhood_ids were received but are not applied: the old Yad2 URL format has no verified neighborhood parameter.',
          }
        : {}),
      actor_input: { max_pages_per_search: MAX_PAGES_PER_SEARCH, max_requests_per_crawl: MAX_REQUESTS_PER_CRAWL },
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  )
}
