import { NEIGHBORHOOD_ALIASES, aliasKey } from './normalize'

const APIFY_API = 'https://api.apify.com/v2'
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_.-]+(~[A-Za-z0-9_.-]+)?$/
const HEBREW = /[\u0590-\u05FF]/

/** Per-run result cap (actor field `maxItems`). Keeps one search cheap while testing. */
export const MADLAN_MAX_ITEMS_PER_RUN = 50
/** The actor takes ONE `neighbourhood` text filter, so each neighborhood is its own run. */
export const MADLAN_MAX_RUNS_PER_SEARCH = 3

const CITY_INPUT: Record<string, string> = { 'tel aviv': 'Tel Aviv' }
const TEL_AVIV_KEYS = new Set(['tel aviv', 'tel aviv yafo', 'tel aviv jaffa', 'tlv', 'תל אביב', 'תל אביב יפו'])

/**
 * Input accepted by swerve/madlan-scraper (build 1.0.61). Only confirmed schema fields are used:
 * city, dealType, maxItems, minPrice, maxPrice, minRooms, maxRooms, neighbourhood,
 * requireParking, requireElevator, requireBalcony, requireSecureRoom.
 */
export type MadlanActorInput = {
  city: string
  /** Actor enum: "rent" (שכירות) or "buy" (מכירה). */
  dealType: 'rent' | 'buy'
  maxItems: number
  minPrice?: number
  maxPrice?: number
  minRooms?: number
  maxRooms?: number
  neighbourhood?: string
  requireParking?: true
  requireElevator?: true
  requireBalcony?: true
  requireSecureRoom?: true
}

export type MadlanCriteria = {
  city: string
  transactionType: 'rent' | 'sale'
  minPrice: number | null
  maxPrice: number | null
  minRooms: number | null
  maxRooms: number | null
  parking: boolean
  elevator: boolean
  balcony: boolean
  mamad: boolean
  /** Hebrew neighbourhood filters, one run each. Empty = one city-wide run. */
  neighbourhoods: { name: string; hebrew: string }[]
}

export type MadlanStartedRun = { runId: string; status: string; actorInput: MadlanActorInput }

export type MadlanStartResult =
  | {
      ok: true
      runs: MadlanStartedRun[]
      failedRuns: { actorInput: MadlanActorInput; error: string; limitReached: boolean }[]
    }
  | { ok: false; httpStatus: number; error: string; details?: string[]; limitReached?: boolean }

function readNumber(body: Record<string, unknown>, key: string, errors: string[]) {
  const value = body[key]
  if (value === undefined || value === null || value === '') return null
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0) {
    errors.push(`${key} must be a positive number.`)
    return null
  }
  return num
}

function readFlag(body: Record<string, unknown>, key: string, errors: string[]) {
  const value = body[key]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') errors.push(`${key} must be true or false.`)
  return value === true
}

/** Dashboard neighborhood (English or Hebrew) → Hebrew text for the actor, or null if unknown. */
export function toMadlanNeighbourhood(name: string): string | null {
  if (HEBREW.test(name)) return name.trim()
  const key = aliasKey(name)
  for (const [canonical, aliases] of Object.entries(NEIGHBORHOOD_ALIASES)) {
    if ([canonical, ...aliases].some((alias) => aliasKey(alias) === key)) {
      return aliases.find((alias) => HEBREW.test(alias)) ?? null
    }
  }
  return null
}

export function validateMadlanCriteria(
  input: unknown,
): { ok: true; data: MadlanCriteria } | { ok: false; status: number; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, errors: ['Request body must be a JSON object.'] }
  }
  const body = input as Record<string, unknown>

  const cityKey = typeof body.city === 'string' ? body.city.trim().toLowerCase().replace(/[-_\s]+/g, ' ') : ''
  if (!TEL_AVIV_KEYS.has(cityKey)) {
    return { ok: false, status: 400, errors: [`Unsupported city "${String(body.city ?? '')}". Supported: Tel Aviv.`] }
  }
  const transactionType = typeof body.transaction_type === 'string' ? body.transaction_type.trim().toLowerCase() : ''
  if (transactionType !== 'rent' && transactionType !== 'sale') {
    return {
      ok: false,
      status: 400,
      errors: [`Unsupported transaction_type "${String(body.transaction_type ?? '')}". Supported: rent, sale.`],
    }
  }

  const errors: string[] = []
  const minPrice = readNumber(body, 'min_price', errors)
  const maxPrice = readNumber(body, 'max_price', errors)
  const minRooms = readNumber(body, 'min_rooms', errors)
  const maxRooms = readNumber(body, 'max_rooms', errors)
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) errors.push('min_price must be ≤ max_price.')
  if (minRooms !== null && maxRooms !== null && minRooms > maxRooms) errors.push('min_rooms must be ≤ max_rooms.')
  if ((minRooms ?? 0) > 20 || (maxRooms ?? 0) > 20) errors.push('Rooms must be 20 or less.')

  const parking = readFlag(body, 'parking', errors)
  const elevator = readFlag(body, 'elevator', errors)
  const balcony = readFlag(body, 'balcony', errors)
  const mamad = readFlag(body, 'mamad', errors)

  const neighbourhoods: MadlanCriteria['neighbourhoods'] = []
  if (body.neighborhoods !== undefined && body.neighborhoods !== null) {
    if (!Array.isArray(body.neighborhoods) || body.neighborhoods.some((n) => typeof n !== 'string')) {
      errors.push('neighborhoods must be an array of strings.')
    } else {
      const names = [...new Set((body.neighborhoods as string[]).map((n) => n.trim()).filter(Boolean))]
      const unknown: string[] = []
      for (const name of names) {
        if (name.length > 80) {
          errors.push('Each neighborhood must be 80 characters or less.')
          continue
        }
        const hebrew = toMadlanNeighbourhood(name)
        if (hebrew) neighbourhoods.push({ name, hebrew })
        else unknown.push(name)
      }
      // Never silently drop a selection: an unmapped neighborhood is a hard error.
      if (unknown.length > 0) {
        errors.push(`No Hebrew Madlan name is known for: ${unknown.join(', ')}.`)
      }
      if (neighbourhoods.length > MADLAN_MAX_RUNS_PER_SEARCH) {
        errors.push(
          `Madlan accepts one neighborhood per run; at most ${MADLAN_MAX_RUNS_PER_SEARCH} neighborhoods can be searched at once.`,
        )
      }
    }
  }

  if (errors.length > 0) return { ok: false, status: 400, errors }
  return {
    ok: true,
    data: {
      city: CITY_INPUT['tel aviv'],
      transactionType,
      minPrice,
      maxPrice,
      minRooms,
      maxRooms,
      parking,
      elevator,
      balcony,
      mamad,
      neighbourhoods,
    },
  }
}

/** One actor input per neighborhood, or a single city-wide input. Unset filters are omitted, not sent as false. */
export function buildMadlanActorInputs(criteria: MadlanCriteria): MadlanActorInput[] {
  const base: MadlanActorInput = {
    city: criteria.city,
    dealType: criteria.transactionType === 'sale' ? 'buy' : 'rent',
    maxItems: MADLAN_MAX_ITEMS_PER_RUN,
  }
  if (criteria.minPrice !== null) base.minPrice = Math.round(criteria.minPrice)
  if (criteria.maxPrice !== null) base.maxPrice = Math.round(criteria.maxPrice)
  if (criteria.minRooms !== null) base.minRooms = criteria.minRooms
  if (criteria.maxRooms !== null) base.maxRooms = criteria.maxRooms
  if (criteria.parking) base.requireParking = true
  if (criteria.elevator) base.requireElevator = true
  if (criteria.balcony) base.requireBalcony = true
  if (criteria.mamad) base.requireSecureRoom = true

  if (criteria.neighbourhoods.length === 0) return [base]
  return criteria.neighbourhoods.map(({ hebrew }) => ({ ...base, neighbourhood: hebrew }))
}

function readApifyConfig() {
  const token = process.env.APIFY_API_TOKEN?.trim()
  const actorId = process.env.APIFY_MADLAN_ACTOR_ID?.trim().replace('/', '~')
  if (!token) return { ok: false as const, error: 'Madlan search is not configured (APIFY_API_TOKEN is missing).' }
  if (!actorId || !ACTOR_ID_PATTERN.test(actorId)) {
    return { ok: false as const, error: 'Madlan search is not configured (APIFY_MADLAN_ACTOR_ID is missing or invalid).' }
  }
  return { ok: true as const, token, actorId }
}

const LIMIT_ERROR_PATTERN = /limit|concurren|memory|quota|exceeded/i

async function launchRun(config: { token: string; actorId: string }, actorInput: MadlanActorInput) {
  let response: Response
  try {
    response = await fetch(`${APIFY_API}/acts/${encodeURIComponent(config.actorId)}/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(actorInput),
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    console.error('madlan-search: Apify request failed', error)
    return { ok: false as const, httpStatus: 502, error: 'Could not reach the Apify API.', limitReached: false }
  }

  const result = (await response.json().catch(() => null)) as
    | { data?: { id?: string; status?: string }; error?: { type?: string; message?: string } }
    | null
  if (!response.ok || !result?.data?.id) {
    const message = result?.error?.message ?? `Apify returned HTTP ${response.status}.`
    const limitReached =
      response.status === 402 ||
      response.status === 429 ||
      LIMIT_ERROR_PATTERN.test(`${result?.error?.type ?? ''} ${result?.error?.message ?? ''}`)
    console.error('madlan-search: Apify rejected the run', response.status, result?.error)
    return { ok: false as const, httpStatus: limitReached ? 429 : 502, error: message, limitReached }
  }
  return { ok: true as const, run: { runId: result.data.id, status: result.data.status ?? 'READY', actorInput } }
}

const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,32}$/

export type MadlanRunStatusResult =
  | { ok: true; runId: string; status: string; finishedAt: string | null }
  | { ok: false; error: string }

async function apifyGetJson<T>(path: string, token: string) {
  const response = await fetch(`${APIFY_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  })
  return { ok: response.ok, status: response.status, body: (await response.json().catch(() => null)) as T | null }
}

/** Read-only status of a Madlan run. Runs of any other actor (e.g. Yad2) are reported as not found. */
export async function getMadlanRunStatus(runId: string): Promise<MadlanRunStatusResult> {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return { ok: false, error: 'Invalid run id.' }
  const config = readApifyConfig()
  if (!config.ok) return { ok: false, error: config.error }
  try {
    const [run, actor] = await Promise.all([
      apifyGetJson<{ data?: { status?: string; finishedAt?: string | null; actId?: string } }>(
        `/actor-runs/${encodeURIComponent(runId)}`,
        config.token,
      ),
      apifyGetJson<{ data?: { id?: string } }>(`/acts/${encodeURIComponent(config.actorId)}`, config.token),
    ])
    if (!run.ok || !run.body?.data?.status) {
      return { ok: false, error: run.status === 404 ? 'Run not found.' : `Apify returned HTTP ${run.status}.` }
    }
    const actorInternalId = actor.ok ? actor.body?.data?.id : undefined
    if (actorInternalId && run.body.data.actId && run.body.data.actId !== actorInternalId) {
      return { ok: false, error: 'Run not found.' }
    }
    return { ok: true, runId, status: run.body.data.status, finishedAt: run.body.data.finishedAt ?? null }
  } catch (error) {
    console.error('madlan-search: could not read run status', error)
    return { ok: false, error: 'Could not reach the Apify API.' }
  }
}

export type MadlanInputRunsResult =
  | { ok: true; runs: MadlanStartedRun[]; failedRuns: { actorInput: MadlanActorInput; error: string; limitReached: boolean }[] }
  | { ok: false; error: string }

/**
 * Starts one run per already-built actor input (from buildMadlanActorInputs). Used by the scheduled refresh,
 * which deduplicates inputs across saved searches before launching.
 */
export async function startMadlanActorInputs(inputs: readonly MadlanActorInput[]): Promise<MadlanInputRunsResult> {
  const config = readApifyConfig()
  if (!config.ok) return { ok: false, error: config.error }
  const runs: MadlanStartedRun[] = []
  const failedRuns: { actorInput: MadlanActorInput; error: string; limitReached: boolean }[] = []
  for (const actorInput of inputs) {
    const result = await launchRun(config, actorInput)
    if (result.ok) runs.push(result.run)
    else failedRuns.push({ actorInput, error: result.error, limitReached: result.limitReached })
  }
  return { ok: true, runs, failedRuns }
}

/** Starts one Madlan actor run per actor input. Results arrive via /api/apify-madlan-webhook. */
export async function startMadlanRuns(criteria: MadlanCriteria): Promise<MadlanStartResult> {
  const config = readApifyConfig()
  if (!config.ok) return { ok: false, httpStatus: 500, error: config.error }

  const runs: MadlanStartedRun[] = []
  const failedRuns: { actorInput: MadlanActorInput; error: string; limitReached: boolean }[] = []
  for (const actorInput of buildMadlanActorInputs(criteria)) {
    const result = await launchRun(config, actorInput)
    if (result.ok) runs.push(result.run)
    else failedRuns.push({ actorInput, error: result.error, limitReached: result.limitReached })
  }

  if (runs.length === 0) {
    const limitReached = failedRuns.some((f) => f.limitReached)
    return {
      ok: false,
      httpStatus: limitReached ? 429 : 502,
      error: limitReached ? 'Apify concurrency limit reached.' : 'Failed to start the Madlan actor.',
      details: failedRuns.map((f) => f.error),
      limitReached,
    }
  }
  return { ok: true, runs, failedRuns }
}
