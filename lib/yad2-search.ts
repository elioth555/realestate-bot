const MAX_PAGES_PER_SEARCH = 1
const MAX_REQUESTS_PER_CRAWL = 50
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_.-]+(~[A-Za-z0-9_.-]+)?$/
const NEIGHBORHOOD_ID_PATTERN = /^\d{1,6}$/
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,32}$/
const APIFY_API = 'https://api.apify.com/v2'

// Old Yad2 URL format known to be accepted by the Apify actor. Only Tel Aviv rentals are supported for now.
const CITY_CONFIG: Record<string, { path: string; params: Record<string, string> }> = {
  'tel aviv': { path: 'rent', params: { topArea: '2', area: '1', city: '5000' } },
}
const SUPPORTED_TRANSACTION_TYPES = ['rent']

export const ACTIVE_RUN_STATUSES = ['READY', 'RUNNING']
export const TERMINAL_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']

export type SearchCriteria = {
  cityKey: string
  minRooms: number | null
  maxRooms: number | null
  maxPrice: number | null
  neighborhoodIds: string[]
}

export type ActorInput = {
  start_urls: { url: string }[]
  max_pages_per_search: number
  max_requests_per_crawl: number
}

export type StartRunResult =
  | {
      ok: true
      runId: string
      status: string
      searchUrl: string
      actorInput: ActorInput
      reusedActiveRun: boolean
    }
  | { ok: false; httpStatus: number; error: string; details?: string[]; actorInput?: ActorInput }

export type RunStatusResult =
  | { ok: true; runId: string; status: string; finishedAt: string | null }
  | { ok: false; error: string }

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

export function validateCriteria(
  input: unknown,
): { ok: true; data: SearchCriteria } | { ok: false; status: number; errors: string[] } {
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

function readApifyConfig() {
  const token = process.env.APIFY_API_TOKEN?.trim()
  const actorId = process.env.APIFY_YAD2_ACTOR_ID?.trim().replace('/', '~')
  if (!token) return { ok: false as const, error: 'Search is not configured (APIFY_API_TOKEN is missing).' }
  if (!actorId || !ACTOR_ID_PATTERN.test(actorId)) {
    return { ok: false as const, error: 'Search is not configured (APIFY_YAD2_ACTOR_ID is missing or invalid).' }
  }
  return { ok: true as const, token, actorId }
}

async function apifyGet<T>(path: string, token: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  const response = await fetch(`${APIFY_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  })
  const body = (await response.json().catch(() => null)) as T | null
  return { ok: response.ok, status: response.status, body }
}

type RunSummary = { id?: string; status?: string; actId?: string; finishedAt?: string | null }

async function findActiveRun(actorId: string, token: string) {
  try {
    const { ok, body } = await apifyGet<{ data?: { items?: RunSummary[] } }>(
      `/acts/${encodeURIComponent(actorId)}/runs?desc=true&limit=10`,
      token,
    )
    if (!ok) return null
    return body?.data?.items?.find((run) => run.id && run.status && ACTIVE_RUN_STATUSES.includes(run.status)) ?? null
  } catch (error) {
    console.error('yad2-search: could not list active runs', error)
    return null
  }
}

/**
 * Starts the Yad2 actor. When `reuseActiveRun` is true and a run of the actor is already
 * READY/RUNNING, that run is returned instead of launching a duplicate.
 */
export async function startYad2Run(
  criteria: SearchCriteria,
  { reuseActiveRun = false }: { reuseActiveRun?: boolean } = {},
): Promise<StartRunResult> {
  const config = readApifyConfig()
  if (!config.ok) return { ok: false, httpStatus: 500, error: config.error }

  const searchUrl = buildSearchUrl(criteria)
  const actorInput: ActorInput = {
    start_urls: [{ url: searchUrl }],
    max_pages_per_search: MAX_PAGES_PER_SEARCH,
    max_requests_per_crawl: MAX_REQUESTS_PER_CRAWL,
  }

  if (reuseActiveRun) {
    const active = await findActiveRun(config.actorId, config.token)
    if (active?.id) {
      return {
        ok: true,
        runId: active.id,
        status: active.status ?? 'RUNNING',
        searchUrl,
        actorInput,
        reusedActiveRun: true,
      }
    }
  }

  let apifyResponse: Response
  try {
    apifyResponse = await fetch(`${APIFY_API}/acts/${encodeURIComponent(config.actorId)}/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(actorInput),
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    console.error('yad2-search: Apify request failed', error)
    return { ok: false, httpStatus: 502, error: 'Could not reach the Apify API.' }
  }

  const result = (await apifyResponse.json().catch(() => null)) as
    | { data?: { id?: string; status?: string }; error?: { type?: string; message?: string } }
    | null

  if (!apifyResponse.ok || !result?.data?.id) {
    const message = result?.error?.message ?? `Apify returned HTTP ${apifyResponse.status}.`
    console.error('yad2-search: Apify rejected the run', apifyResponse.status, result?.error)
    return { ok: false, httpStatus: 502, error: 'Failed to start the Apify actor.', details: [message], actorInput }
  }

  return {
    ok: true,
    runId: result.data.id,
    status: result.data.status ?? 'READY',
    searchUrl,
    actorInput,
    reusedActiveRun: false,
  }
}

let cachedActorInternalId: string | null = null

async function resolveActorInternalId(actorId: string, token: string) {
  if (cachedActorInternalId) return cachedActorInternalId
  const { ok, body } = await apifyGet<{ data?: { id?: string } }>(`/acts/${encodeURIComponent(actorId)}`, token)
  if (ok && body?.data?.id) cachedActorInternalId = body.data.id
  return cachedActorInternalId
}

/** Reads a run's status, refusing runs that do not belong to the configured Yad2 actor. */
export async function getYad2RunStatus(runId: string): Promise<RunStatusResult> {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return { ok: false, error: 'Invalid run id.' }

  const config = readApifyConfig()
  if (!config.ok) return { ok: false, error: config.error }

  try {
    const [run, actorInternalId] = await Promise.all([
      apifyGet<{ data?: RunSummary }>(`/actor-runs/${encodeURIComponent(runId)}`, config.token),
      resolveActorInternalId(config.actorId, config.token),
    ])
    if (!run.ok || !run.body?.data?.status) {
      return { ok: false, error: run.status === 404 ? 'Run not found.' : `Apify returned HTTP ${run.status}.` }
    }
    if (actorInternalId && run.body.data.actId && run.body.data.actId !== actorInternalId) {
      return { ok: false, error: 'Run not found.' }
    }
    return { ok: true, runId, status: run.body.data.status, finishedAt: run.body.data.finishedAt ?? null }
  } catch (error) {
    console.error('yad2-search: could not read run status', error)
    return { ok: false, error: 'Could not reach the Apify API.' }
  }
}
