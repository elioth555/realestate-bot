import type { SavedSearch } from './saved-searches'
import { buildSourceInputs, type SourceKey } from './refresh-all'
import { buildSearchUrls, validateCriteria } from './yad2-search'
import { buildMadlanActorInputs, validateMadlanCriteria, type MadlanActorInput } from './madlan-search'
import { DAILY_ALERT_TIMEZONE, israelHour } from './saved-search-alerts'

/** The daily source refresh runs in the 06:xx hour in Israel, ahead of the 08:00 email alerts. */
export const SCHEDULED_REFRESH_HOUR = 6
export const isScheduledRefreshWindow = (now: Date) => israelHour(now) === SCHEDULED_REFRESH_HOUR

/** Upper bound on deduplicated runs per source per day, so a burst of saved searches cannot blow the Apify budget. */
export const MAX_SCHEDULED_RUNS: Record<'yad2' | 'madlan', number> = { yad2: 12, madlan: 12 }

/** Calendar date in Israel (YYYY-MM-DD): the claim key for one daily refresh. */
export function israelDateKey(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DAILY_ALERT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export type PlannedRun<T> = { key: string; input: T; savedSearchIds: string[] }
export type PlanSkip = { savedSearchId: string; source: SourceKey; reason: string }
export type PlanNote = { savedSearchId: string; source: SourceKey; note: string }

export type RefreshPlan = {
  yad2: PlannedRun<string>[]
  madlan: PlannedRun<MadlanActorInput>[]
  facebook: { savedSearchIds: string[] } | null
  /** A saved search that gets no run from this source (e.g. a city the scraper does not support). */
  skipped: PlanSkip[]
  /** A saved search that is covered, but with a broader run than its own criteria. */
  notes: PlanNote[]
  /** Deduplicated runs left out because the per-source daily cap was reached. */
  capped: { source: 'yad2' | 'madlan'; key: string; savedSearchIds: string[] }[]
}

const TEL_AVIV_ALIASES = new Set(['tel aviv', 'tel aviv yafo', 'tel aviv jaffa', 'tlv', 'תל אביב', 'תל אביב יפו'])
const isTelAviv = (city: string | null) => !!city && TEL_AVIV_ALIASES.has(city.trim().toLowerCase().replace(/[-_\s]+/g, ' '))

/** Key-sorted JSON, so two equal Madlan inputs built in any key order produce the same dedupe key. */
export function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

type Built<T> = { ok: true; inputs: T[]; note?: string } | { ok: false; reason: string }

/** Same request shape as app/actions/yad2.ts (min price is filtered locally after import). */
function yad2UrlsFor(search: SavedSearch): Built<string> {
  const { yad2 } = buildSourceInputs(search.filters, search.scope)
  if (!isTelAviv(yad2.city)) return { ok: false, reason: `Yad2 refresh supports Tel Aviv only (city: ${yad2.city ?? 'none'}).` }
  const body = {
    city: 'Tel Aviv',
    transaction_type: yad2.transactionType,
    min_rooms: yad2.minRooms,
    max_rooms: yad2.maxRooms,
    max_price: yad2.maxPrice,
    neighborhoods: yad2.neighborhoods,
  }
  const v = validateCriteria(body)
  if (v.ok) return { ok: true, inputs: buildSearchUrls(v.data).urls }
  if (body.neighborhoods.length > 0) {
    const cityWide = validateCriteria({ ...body, neighborhoods: [] })
    if (cityWide.ok) return { ok: true, inputs: buildSearchUrls(cityWide.data).urls, note: `Tel Aviv-wide run: ${v.errors.join(' ')}` }
  }
  return { ok: false, reason: v.errors.join(' ') }
}

/** Same request shape as app/actions/madlan.ts. */
function madlanInputsFor(search: SavedSearch): Built<MadlanActorInput> {
  const { madlan } = buildSourceInputs(search.filters, search.scope)
  if (!isTelAviv(madlan.city)) return { ok: false, reason: `Madlan refresh supports Tel Aviv only (city: ${madlan.city ?? 'none'}).` }
  const amenities = madlan.amenities ?? []
  const body = {
    city: 'Tel Aviv',
    transaction_type: madlan.transactionType,
    min_price: madlan.minPrice,
    max_price: madlan.maxPrice,
    min_rooms: madlan.minRooms,
    max_rooms: madlan.maxRooms,
    parking: amenities.includes('parking'),
    elevator: amenities.includes('elevator'),
    balcony: amenities.includes('balcony'),
    mamad: amenities.includes('mamad'),
    neighborhoods: madlan.neighborhoods,
  }
  const v = validateMadlanCriteria(body)
  if (v.ok) return { ok: true, inputs: buildMadlanActorInputs(v.data) }
  if (body.neighborhoods.length > 0) {
    const cityWide = validateMadlanCriteria({ ...body, neighborhoods: [] })
    if (cityWide.ok) return { ok: true, inputs: buildMadlanActorInputs(cityWide.data), note: `Tel Aviv-wide run: ${v.errors.join(' ')}` }
  }
  return { ok: false, reason: v.errors.join(' ') }
}

function addRun<T>(runs: Map<string, PlannedRun<T>>, key: string, input: T, searchId: string) {
  const existing = runs.get(key)
  if (!existing) runs.set(key, { key, input, savedSearchIds: [searchId] })
  else if (!existing.savedSearchIds.includes(searchId)) existing.savedSearchIds.push(searchId)
}

/**
 * One refresh plan per saved search, deduplicated across searches: equal Yad2 search URLs and equal Madlan
 * actor inputs collapse into one run, and the imported listings then match every saved search locally.
 * Only deal types used by a saved search are planned. Facebook runs once over the configured group list.
 */
export function planScheduledRefresh(searches: readonly SavedSearch[]): RefreshPlan {
  const yad2 = new Map<string, PlannedRun<string>>()
  const madlan = new Map<string, PlannedRun<MadlanActorInput>>()
  const skipped: PlanSkip[] = []
  const notes: PlanNote[] = []

  for (const search of searches) {
    const y = yad2UrlsFor(search)
    if (y.ok) {
      for (const url of y.inputs) addRun(yad2, url, url, search.id)
      if (y.note) notes.push({ savedSearchId: search.id, source: 'yad2', note: y.note })
    } else skipped.push({ savedSearchId: search.id, source: 'yad2', reason: y.reason })

    const m = madlanInputsFor(search)
    if (m.ok) {
      for (const input of m.inputs) addRun(madlan, stableKey(input), input, search.id)
      if (m.note) notes.push({ savedSearchId: search.id, source: 'madlan', note: m.note })
    } else skipped.push({ savedSearchId: search.id, source: 'madlan', reason: m.reason })
  }

  const capped: RefreshPlan['capped'] = []
  const cap = <T>(source: 'yad2' | 'madlan', runs: PlannedRun<T>[]) => {
    for (const r of runs.slice(MAX_SCHEDULED_RUNS[source])) capped.push({ source, key: r.key, savedSearchIds: r.savedSearchIds })
    return runs.slice(0, MAX_SCHEDULED_RUNS[source])
  }

  return {
    yad2: cap('yad2', [...yad2.values()]),
    madlan: cap('madlan', [...madlan.values()]),
    facebook: searches.length > 0 ? { savedSearchIds: searches.map((s) => s.id) } : null,
    skipped,
    notes,
    capped,
  }
}

export type SourceStartResult =
  | { ok: true; runIds: string[]; failures: { key: string; error: string; limitReached: boolean }[] }
  | { ok: false; error: string }

export type ClaimResult = { status: 'claimed' } | { status: 'already-claimed' } | { status: 'error'; message: string }

export type SourceOutcomeStatus = 'would-start' | 'started' | 'partial' | 'failed' | 'already-claimed' | 'claim-failed' | 'nothing-to-run'

export type SourceOutcome = {
  source: SourceKey
  status: SourceOutcomeStatus
  plannedRuns: number
  startedRuns: number
  runIds: string[]
  errors: string[]
  runs: { key: string; savedSearchIds: string[] }[]
  recordError?: string
}

export type SourceRecord = { status: 'started' | 'partial' | 'failed'; startedRuns: number; runIds: string[]; error: string | null }

const SOURCES: readonly SourceKey[] = ['yad2', 'madlan', 'facebook']

function plannedFor(plan: RefreshPlan, source: SourceKey): { key: string; savedSearchIds: string[] }[] {
  if (source === 'facebook') return plan.facebook ? [{ key: 'facebook-groups', savedSearchIds: plan.facebook.savedSearchIds }] : []
  return plan[source].map((r) => ({ key: r.key, savedSearchIds: r.savedSearchIds }))
}

/**
 * Claims and starts each source independently and in parallel. A throw, refusal or claim failure on one
 * source never affects the others. Dry run: no claim, no Apify call, no write — only the plan is reported.
 */
export async function runScheduledRefresh(deps: {
  plan: RefreshPlan
  dryRun: boolean
  claim: (source: SourceKey, plannedRuns: number) => Promise<ClaimResult>
  record: (source: SourceKey, result: SourceRecord) => Promise<void>
  start: Record<SourceKey, (plan: RefreshPlan) => Promise<SourceStartResult>>
}): Promise<SourceOutcome[]> {
  const runOne = async (source: SourceKey): Promise<SourceOutcome> => {
    const runs = plannedFor(deps.plan, source)
    const base: SourceOutcome = { source, status: 'nothing-to-run', plannedRuns: runs.length, startedRuns: 0, runIds: [], errors: [], runs }
    if (runs.length === 0) return base
    if (deps.dryRun) return { ...base, status: 'would-start' }

    let claim: ClaimResult
    try {
      claim = await deps.claim(source, runs.length)
    } catch (error) {
      claim = { status: 'error', message: error instanceof Error ? error.message : 'Claim failed.' }
    }
    if (claim.status === 'already-claimed') return { ...base, status: 'already-claimed' }
    if (claim.status === 'error') return { ...base, status: 'claim-failed', errors: [claim.message] }

    let started: SourceStartResult
    try {
      started = await deps.start[source](deps.plan)
    } catch (error) {
      started = { ok: false, error: error instanceof Error ? error.message : 'Start failed.' }
    }
    const runIds = started.ok ? started.runIds : []
    const errors = started.ok ? started.failures.map((f) => `${f.limitReached ? '[limit] ' : ''}${f.error}`) : [started.error]
    const status: SourceRecord['status'] = runIds.length === 0 ? 'failed' : errors.length > 0 ? 'partial' : 'started'
    const outcome: SourceOutcome = { ...base, status, startedRuns: runIds.length, runIds, errors }

    try {
      await deps.record(source, { status, startedRuns: runIds.length, runIds, error: errors.length > 0 ? errors.join(' | ').slice(0, 2000) : null })
    } catch (error) {
      outcome.recordError = error instanceof Error ? error.message : 'Could not record the outcome.'
    }
    return outcome
  }

  const settled = await Promise.allSettled(SOURCES.map(runOne))
  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { source: SOURCES[i], status: 'failed', plannedRuns: 0, startedRuns: 0, runIds: [], errors: [String(r.reason)], runs: [] },
  )
}
