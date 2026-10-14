import { resolveYad2Neighborhoods, type Yad2NeighborhoodResolution } from './yad2-neighborhoods'

const MAX_PAGES_PER_SEARCH = 1
const MAX_REQUESTS_PER_CRAWL = 50
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_.-]+(~[A-Za-z0-9_.-]+)?$/
const NEIGHBORHOOD_ID_PATTERN = /^\d{1,6}$/
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,32}$/
const APIFY_API = 'https://api.apify.com/v2'

// Old Yad2 URL format known to be accepted by the Apify actor (Tel Aviv only). The actor schema accepts both
// /realestate/rent and /realestate/forsale with the same query parameters.
const CITY_CONFIG: Record<string, { params: Record<string, string> }> = {
  'tel aviv': { params: { topArea: '2', area: '1', city: '5000' } },
}
export type Yad2TransactionType = 'rent' | 'sale'
const PATH_BY_TRANSACTION_TYPE: Record<Yad2TransactionType, string> = { rent: 'rent', sale: 'forsale' }
const TRANSACTION_TYPE_BY_PATH: Record<string, Yad2TransactionType> = { rent: 'rent', forsale: 'sale' }
const SUPPORTED_TRANSACTION_TYPES = ['rent', 'sale']

/** Deal type of a Yad2 search URL, from its `/realestate/<rent|forsale>` path. Null if it is neither. */
export function yad2TransactionTypeFromUrl(url: string): Yad2TransactionType | null {
  try {
    const match = new URL(url).pathname.match(/^\/realestate\/([a-z]+)\/?$/i)
    return match ? (TRANSACTION_TYPE_BY_PATH[match[1].toLowerCase()] ?? null) : null
  } catch {
    return null
  }
}

/**
 * Deal type of a whole run, from the `start_urls` it was started with. Items carry no deal-type field
 * (item_url is just /item/<id>), so the run input is the only reliable source.
 */
export function yad2TransactionTypeFromActorInput(
  input: unknown,
): { ok: true; transactionType: Yad2TransactionType } | { ok: false; error: string } {
  const startUrls = (input as { start_urls?: unknown } | null)?.start_urls
  if (!Array.isArray(startUrls) || startUrls.length === 0) return { ok: false, error: 'Run input has no start_urls.' }
  const types = new Set<Yad2TransactionType | null>(
    startUrls.map((entry) => {
      const url = typeof entry === 'string' ? entry : (entry as { url?: unknown } | null)?.url
      return typeof url === 'string' ? yad2TransactionTypeFromUrl(url) : null
    }),
  )
  if (types.has(null)) return { ok: false, error: 'A start URL is neither /realestate/rent nor /realestate/forsale.' }
  if (types.size !== 1) return { ok: false, error: 'Run mixes rent and sale start URLs.' }
  return { ok: true, transactionType: [...types][0] as Yad2TransactionType }
}

export const ACTIVE_RUN_STATUSES = ['READY', 'RUNNING']
export const TERMINAL_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']

const MAX_NEIGHBORHOODS = 20
// The actor-compatible URL takes a single `neighborhood=<ID>`, so each Yad2 ID gets its own run.
// Capped to keep one search from monopolising the Apify concurrency limit.
const MAX_RUNS_PER_SEARCH = 6

export type SearchCriteria = {
  cityKey: string
  transactionType: Yad2TransactionType
  minRooms: number | null
  maxRooms: number | null
  maxPrice: number | null
  neighborhoods: Yad2NeighborhoodResolution
}

export type ActorInput = {
  start_urls: { url: string }[]
  maxPagesPerSearch: number
  maxRequestsPerCrawl: number
}

export type StartedRun = { runId: string; status: string; searchUrl: string; actorInput: ActorInput }

export type StartRunResult =
  | {
      ok: true
      /** First run, kept for single-run callers. */
      runId: string
      status: string
      searchUrl: string
      actorInput: ActorInput
      runs: StartedRun[]
      /** URLs whose run could not be started while others did. */
      failedRuns: { searchUrl: string; error: string; limitReached: boolean }[]
    }
  | {
      ok: false
      httpStatus: number
      error: string
      details?: string[]
      actorInput?: ActorInput
      /** Apify refused the run because a concurrency/memory limit is reached. */
      limitReached?: boolean
    }

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
      errors: [`Unsupported transaction_type "${String(body.transaction_type ?? '')}". Supported: rent, sale.`],
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

  let neighborhoodNames: string[] = []
  if (body.neighborhoods !== undefined && body.neighborhoods !== null) {
    if (!Array.isArray(body.neighborhoods) || body.neighborhoods.some((n) => typeof n !== 'string')) {
      errors.push('neighborhoods must be an array of strings.')
    } else {
      neighborhoodNames = body.neighborhoods.map((n: string) => n.trim()).filter(Boolean)
      if (neighborhoodNames.some((n) => n.length > 80)) errors.push('Each neighborhood must be 80 characters or less.')
    }
  }
  if (neighborhoodNames.length + neighborhoodIds.length > MAX_NEIGHBORHOODS) {
    errors.push(`At most ${MAX_NEIGHBORHOODS} neighborhoods can be requested.`)
  }

  if (errors.length > 0) return { ok: false, status: 400, errors }
  const neighborhoods = resolveYad2Neighborhoods(neighborhoodNames, neighborhoodIds)
  // Each Yad2 ID is one run; an unsupported selection falls back to a single city-wide run (see buildSearchUrls).
  if (neighborhoods.unsupported.length === 0 && neighborhoods.ids.length > MAX_RUNS_PER_SEARCH) {
    return {
      ok: false,
      status: 400,
      errors: [
        `These neighborhoods need ${neighborhoods.ids.length} Yad2 searches; at most ${MAX_RUNS_PER_SEARCH} can run at once. Select fewer neighborhoods, or none for a Tel Aviv-wide search.`,
      ],
    }
  }
  return {
    ok: true,
    data: { cityKey, transactionType: transactionType as Yad2TransactionType, minRooms, maxRooms, maxPrice, neighborhoods },
  }
}

function buildUrlFor(criteria: SearchCriteria, neighborhoodId: string | null) {
  const city = CITY_CONFIG[criteria.cityKey]
  const url = new URL(`https://www.yad2.co.il/realestate/${PATH_BY_TRANSACTION_TYPE[criteria.transactionType]}`)
  for (const [key, value] of Object.entries(city.params)) url.searchParams.set(key, value)
  if (neighborhoodId) url.searchParams.set('neighborhood', neighborhoodId)
  if (criteria.minRooms !== null) url.searchParams.set('minRooms', String(criteria.minRooms))
  if (criteria.maxRooms !== null) url.searchParams.set('maxRooms', String(criteria.maxRooms))
  if (criteria.maxPrice !== null) url.searchParams.set('maxPrice', String(Math.round(criteria.maxPrice)))
  return url.toString()
}

/**
 * One actor-compatible URL per Yad2 neighborhood ID (single `neighborhood=<ID>` each), or one city-wide URL.
 * If any selected neighborhood has no confirmed ID, a city-wide run is used so it is not silently skipped;
 * the local any-of neighborhood filter still narrows the results.
 */
export function buildSearchUrls(criteria: SearchCriteria) {
  const ids = criteria.neighborhoods.unsupported.length > 0 ? [] : criteria.neighborhoods.ids
  const urls = ids.length > 0 ? ids.map((id) => buildUrlFor(criteria, id)) : [buildUrlFor(criteria, null)]
  return { urls, neighborhoodFilterApplied: ids.length > 0 }
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

function actorInputFor(searchUrl: string): ActorInput {
  return {
    start_urls: [{ url: searchUrl }],
    maxPagesPerSearch: MAX_PAGES_PER_SEARCH,
    maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL,
  }
}

/**
 * Starts one Yad2 actor run per generated URL; every run is imported by the existing webhook and
 * deduped by `source_url`. Always launches new runs for this search — unrelated active runs are never reused.
 */
export async function startYad2Run(criteria: SearchCriteria): Promise<StartRunResult> {
  const config = readApifyConfig()
  if (!config.ok) return { ok: false, httpStatus: 500, error: config.error }

  const { urls } = buildSearchUrls(criteria)

  // Sequential so a failure (e.g. quota) is reported per URL without a burst of parallel launches.
  const runs: StartedRun[] = []
  const failedRuns: { searchUrl: string; error: string; limitReached: boolean }[] = []
  let lastFailure: Extract<StartRunResult, { ok: false }> | null = null
  for (const searchUrl of urls) {
    const result = await launchRun(config, searchUrl)
    if (result.ok) {
      runs.push(result.run)
    } else {
      lastFailure = result.failure
      failedRuns.push({
        searchUrl,
        error: [result.failure.error, ...(result.failure.details ?? [])].join(' '),
        limitReached: result.failure.limitReached === true,
      })
    }
  }

  if (runs.length === 0) return lastFailure ?? { ok: false, httpStatus: 502, error: 'Failed to start the Apify actor.' }
  return { ok: true, ...runs[0], runs, failedRuns }
}

// Apify rejects new runs with 402/429 or these error types when the account's concurrency/memory limit is reached.
const LIMIT_ERROR_PATTERN = /limit|concurren|memory|quota|exceeded/i

function isLimitRejection(httpStatus: number, error?: { type?: string; message?: string }) {
  if (httpStatus === 402 || httpStatus === 429) return true
  return LIMIT_ERROR_PATTERN.test(`${error?.type ?? ''} ${error?.message ?? ''}`)
}

async function launchRun(
  config: { token: string; actorId: string },
  searchUrl: string,
): Promise<{ ok: true; run: StartedRun } | { ok: false; failure: Extract<StartRunResult, { ok: false }> }> {
  const actorInput = actorInputFor(searchUrl)
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
    return { ok: false, failure: { ok: false, httpStatus: 502, error: 'Could not reach the Apify API.', actorInput } }
  }

  const result = (await apifyResponse.json().catch(() => null)) as
    | { data?: { id?: string; status?: string }; error?: { type?: string; message?: string } }
    | null

  if (!apifyResponse.ok || !result?.data?.id) {
    const message = result?.error?.message ?? `Apify returned HTTP ${apifyResponse.status}.`
    console.error('yad2-search: Apify rejected the run', apifyResponse.status, result?.error)
    const limitReached = isLimitRejection(apifyResponse.status, result?.error)
    return {
      ok: false,
      failure: {
        ok: false,
        httpStatus: limitReached ? 429 : 502,
        error: limitReached
          ? 'Apify concurrency limit reached: another Yad2 run is still active, so a new run could not be started.'
          : 'Failed to start the Apify actor.',
        details: [message],
        actorInput,
        limitReached,
      },
    }
  }

  return {
    ok: true,
    run: { runId: result.data.id, status: result.data.status ?? 'READY', searchUrl, actorInput },
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
