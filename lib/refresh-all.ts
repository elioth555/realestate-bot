import type { DealScope, Filters } from './filters'

export type SourceKey = 'yad2' | 'madlan' | 'facebook'
export const REFRESH_SOURCES: readonly SourceKey[] = ['yad2', 'madlan', 'facebook']
export const SOURCE_LABELS: Record<SourceKey, string> = { yad2: 'Yad2', madlan: 'Madlan', facebook: 'Facebook' }

/** Amenities the Madlan actor can filter on server-side; every other amenity still filters locally. */
export const MADLAN_AMENITY_FILTERS = ['parking', 'elevator', 'balcony', 'mamad'] as const

export type SourceRefreshInput = {
  city: string | null
  transactionType: 'rent' | 'sale'
  minRooms: string | null
  maxRooms: string | null
  minPrice: string
  maxPrice: string
  neighborhoods: string[]
  amenities?: string[]
}

/** Yad2 and Madlan follow the dashboard's Rent/Sale tab and filters. Facebook is not built here: it ignores filters. */
export function buildSourceInputs(filters: Filters, scope: DealScope) {
  const yad2: SourceRefreshInput = {
    city: filters.city,
    transactionType: scope === 'sale' ? 'sale' : 'rent',
    minRooms: filters.minRooms,
    maxRooms: filters.maxRooms,
    minPrice: filters.minPrice,
    maxPrice: filters.maxPrice,
    neighborhoods: [...filters.neighborhoods],
  }
  const madlan: SourceRefreshInput = {
    ...yad2,
    neighborhoods: [...filters.neighborhoods],
    amenities: filters.amenities.filter((a) => (MADLAN_AMENITY_FILTERS as readonly string[]).includes(a)),
  }
  return { yad2, madlan }
}

/** The per-source hook state the coordinator needs. */
export type SourceSnapshot = { phase: string; isStarting: boolean }

const BUSY_PHASES = new Set(['running', 'background', 'importing'])

export function isSourceBusy(s: SourceSnapshot) {
  return s.isStarting || BUSY_PHASES.has(s.phase)
}

/** Sources that need a new run. A source with an active run is attached to instead of started again. */
export function sourcesToStart(snapshots: Record<SourceKey, SourceSnapshot>): SourceKey[] {
  return REFRESH_SOURCES.filter((k) => !isSourceBusy(snapshots[k]))
}

export type StartOutcome = 'started' | 'already-running' | 'refused'

/**
 * Fires every start immediately, without awaiting one before the next, and waits for all of them to settle.
 * A start that throws or refuses is reported for that source only; it never cancels the others.
 */
export async function startSourcesInParallel(
  keys: readonly SourceKey[],
  start: (key: SourceKey) => Promise<StartOutcome>,
): Promise<Partial<Record<SourceKey, StartOutcome>>> {
  const pending = keys.map((key) => {
    try {
      return Promise.resolve(start(key))
    } catch (error) {
      return Promise.reject(error)
    }
  })
  const settled = await Promise.allSettled(pending)
  const outcomes: Partial<Record<SourceKey, StartOutcome>> = {}
  settled.forEach((r, i) => {
    outcomes[keys[i]] = r.status === 'fulfilled' ? r.value : 'refused'
  })
  return outcomes
}

export type SourceResult = 'updated' | 'failed'
export type SourceProgress = 'pending' | SourceResult

/** One "Refresh all sources" press, persisted so a reload keeps the same progress line. */
export type RefreshSession = {
  startedAt: number
  sources: SourceKey[]
  outcomes: Partial<Record<SourceKey, SourceResult>>
}

export const REFRESH_SESSION_KEY = 'realestatebot:refresh-all-session'

export function parseSession(raw: string | null): RefreshSession | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RefreshSession>
    if (typeof parsed.startedAt !== 'number' || !Array.isArray(parsed.sources)) return null
    const sources = REFRESH_SOURCES.filter((k) => parsed.sources!.includes(k))
    if (sources.length === 0) return null
    const outcomes: RefreshSession['outcomes'] = {}
    for (const k of sources) {
      const o = parsed.outcomes?.[k]
      if (o === 'updated' || o === 'failed') outcomes[k] = o
    }
    return { startedAt: parsed.startedAt, sources, outcomes }
  } catch {
    return null
  }
}

/**
 * Where one source stands in the session. A recorded outcome wins; a busy hook is pending; a finished hook
 * reports its own result. An idle hook with no recorded outcome finished before a reload and is counted updated.
 */
export function sourceProgress(key: SourceKey, session: RefreshSession, snapshot: SourceSnapshot): SourceProgress {
  const recorded = session.outcomes[key]
  if (recorded) return recorded
  if (isSourceBusy(snapshot)) return 'pending'
  if (snapshot.phase === 'failed') return 'failed'
  return 'updated'
}

/** Outcome a hook phase should be recorded as, once it reaches a terminal phase. */
export function terminalResult(phase: string): SourceResult | null {
  if (phase === 'done') return 'updated'
  if (phase === 'failed') return 'failed'
  return null
}

function joinLabels(keys: SourceKey[]) {
  const labels = keys.map((k) => SOURCE_LABELS[k])
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

export type RefreshSummary = {
  active: boolean
  complete: number
  total: number
  updated: SourceKey[]
  failed: SourceKey[]
  title: string
  detail: string | null
}

export function summarizeRefresh(session: RefreshSession, progress: Record<SourceKey, SourceProgress>): RefreshSummary {
  const total = session.sources.length
  const updated = session.sources.filter((k) => progress[k] === 'updated')
  const failed = session.sources.filter((k) => progress[k] === 'failed')
  const complete = updated.length + failed.length
  const active = complete < total
  const failedDetail =
    failed.length > 0 ? `${joinLabels(failed)} refresh${failed.length === 1 ? '' : 'es'} failed` : null
  if (active) {
    return { active, complete, total, updated, failed, title: `Refreshing sources… ${complete}/${total} complete`, detail: failedDetail }
  }
  if (failed.length === 0) {
    return { active, complete, total, updated, failed, title: 'Sources updated', detail: null }
  }
  return {
    active,
    complete,
    total,
    updated,
    failed,
    title: `${updated.length} of ${total} sources updated`,
    detail: failedDetail,
  }
}
