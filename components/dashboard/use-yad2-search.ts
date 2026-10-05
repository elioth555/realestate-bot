'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  checkYad2Run,
  startYad2Search,
  type StartYad2SearchResult,
  type Yad2RunStatus,
  type Yad2SearchInput,
} from '@/app/actions/yad2'
import { aliasKey, normalizeCity, normalizeNeighborhood } from '@/lib/normalize'

const MINUTE = 60 * 1000
const LONG_RUNNING_AFTER_MS = 10 * MINUTE
const BACKGROUND_AFTER_MS = 60 * MINUTE
// The Apify webhook imports into Supabase right after the run ends. Offsets from run completion:
// refresh immediately, then keep checking until the data has changed and settled (or the last offset).
const IMPORT_REFRESH_DELAYS_MS = [0, 2000, 5000, 10000, 20000]
const RUN_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/
const MAX_STORED_RUNS = 20

const ACTIVE_STATUSES = new Set(['READY', 'RUNNING'])
const FAILED_STATUSES = new Set(['FAILED', 'ABORTED', 'TIMED-OUT'])
// Permanent answers from the status action; retrying them would lock Search forever.
const UNKNOWN_RUN_ERRORS = new Set(['Run not found.', 'Invalid run id.'])
// Local marker for a run Apify no longer knows about; counted as failed.
const NOT_FOUND = 'NOT-FOUND'

export function pollDelayFor(elapsedMs: number) {
  if (elapsedMs < 2 * MINUTE) return 3000
  if (elapsedMs < LONG_RUNNING_AFTER_MS) return 15000
  if (elapsedMs < BACKGROUND_AFTER_MS) return 30000
  return 0
}

export type RefreshSource = 'yad2' | 'madlan'
/** Dashboard filters sent to a source refresh. `amenities` is only used by sources that filter on them (Madlan). */
export type RefreshInput = Yad2SearchInput & { amenities?: string[] }
export type RunStatusResult = Yad2RunStatus
export type StartRefreshResult = StartYad2SearchResult

/** Everything that differs between sources. Each source gets its own storage key, run IDs and UI state. */
export type SourceRefreshConfig = {
  source: RefreshSource
  label: string
  storageKey: string
  start: (input: RefreshInput) => Promise<StartRefreshResult>
  check: (runId: string) => Promise<RunStatusResult>
}

export const YAD2_REFRESH: SourceRefreshConfig = {
  source: 'yad2',
  label: 'Yad2',
  storageKey: 'realestatebot:yad2-active-run',
  start: (input) =>
    startYad2Search({
      city: input.city,
      transactionType: input.transactionType,
      minRooms: input.minRooms,
      maxRooms: input.maxRooms,
      minPrice: input.minPrice,
      maxPrice: input.maxPrice,
      neighborhoods: input.neighborhoods,
    }),
  check: checkYad2Run,
}

export type Yad2SearchPhase = 'idle' | 'running' | 'background' | 'importing' | 'done' | 'failed'
export type Yad2SearchOutcome = 'running' | 'succeeded' | 'partial' | 'failed'

/** What the finished background update changed in Supabase; null counts mean no baseline was available. */
export type Yad2UpdateSummary = {
  newCount: number | null
  updatedCount: number | null
  succeeded: number
  failed: number
  total: number
}

export type Yad2SearchState = {
  phase: Yad2SearchPhase
  /** Aggregated outcome across every run of the search. */
  outcome: Yad2SearchOutcome | null
  runStatus: string | null
  message: string | null
  startedAt: number | null
  nextPollMs: number | null
  summary: Yad2UpdateSummary | null
}

type SignatureFilters = {
  city: string
  transactionType: 'rent' | 'sale'
  neighborhoods: string[]
  minRooms: string
  maxRooms: string
  minPrice: string
  maxPrice: string
  amenities?: string[]
}

type StoredRuns = { runIds: string[]; startedAt: number; searchSignature: string; filters: SignatureFilters }
type RunTally = { active: number; succeeded: number; failed: number; total: number }

const IDLE: Yad2SearchState = {
  phase: 'idle',
  outcome: null,
  runStatus: null,
  message: null,
  startedAt: null,
  nextPollMs: null,
  summary: null,
}

const clean = (value: string | null | undefined) => (value ?? '').trim()

/** Canonical filters, so "Old North" and "הצפון הישן" (or "Tel Aviv" / "תל אביב יפו") share one signature. */
export function yad2SignatureFilters(input: RefreshInput): SignatureFilters {
  const filters: SignatureFilters = {
    city: input.city ? normalizeCity(input.city) : '',
    transactionType: input.transactionType,
    // Order-independent: "Old North + Florentin" and "Florentin + Old North" are the same search.
    neighborhoods: [...new Set((input.neighborhoods ?? []).map((n) => normalizeNeighborhood(n)).filter(Boolean))].sort(
      (a, b) => aliasKey(a).localeCompare(aliasKey(b)),
    ),
    minRooms: clean(input.minRooms),
    maxRooms: clean(input.maxRooms),
    minPrice: clean(input.minPrice),
    maxPrice: clean(input.maxPrice),
  }
  if (input.amenities && input.amenities.length > 0) filters.amenities = [...new Set(input.amenities)].sort()
  return filters
}

export function yad2SearchSignature(input: RefreshInput) {
  const f = yad2SignatureFilters(input)
  const parts: unknown[] = [
    aliasKey(f.city),
    f.transactionType,
    f.neighborhoods.map(aliasKey),
    f.minRooms,
    f.maxRooms,
    f.minPrice,
    f.maxPrice,
  ]
  // Appended only when present, so Yad2 signatures (no amenities) stay identical to previously saved ones.
  if (f.amenities) parts.push(f.amenities)
  return JSON.stringify(parts)
}

type FingerprintItem = {
  id: string
  price: number
  rooms: number
  surface: number
  source?: string
  features?: Record<string, string>
}

function itemKey(l: FingerprintItem) {
  const features = l.features ? Object.entries(l.features).sort().join(',') : ''
  return `${l.price}:${l.rooms}:${l.surface}:${features}`
}

/** Cheap content hash of the loaded listings, used to tell when the webhook import has landed and settled. */
export function listingsFingerprint(items: readonly FingerprintItem[] | undefined) {
  if (!items) return null
  let hash = 5381
  for (const l of items) {
    const s = `${l.id}:${itemKey(l)};`
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  return `${items.length}:${hash}`
}

type ListingsSnapshot = Map<string, string>

export function snapshotListings(items: readonly FingerprintItem[] | undefined): ListingsSnapshot | null {
  return items ? new Map(items.map((l) => [l.id, itemKey(l)])) : null
}

/** New = id absent from the snapshot taken when the update started; updated = same id, different content. */
export function diffListings(before: ListingsSnapshot | null, after: readonly FingerprintItem[] | undefined) {
  if (!before || !after) return { newCount: null, updatedCount: null }
  let newCount = 0
  let updatedCount = 0
  for (const l of after) {
    const previous = before.get(l.id)
    if (previous === undefined) newCount += 1
    else if (previous !== itemKey(l)) updatedCount += 1
  }
  return { newCount, updatedCount }
}

/** Only this source's listings, so a concurrent refresh of another source never looks like "our" import landing. */
function ofSource(items: readonly FingerprintItem[] | undefined, source: RefreshSource) {
  return items?.filter((l) => l.source === source)
}

function isValidRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}

function clearStoredRuns(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Storage unavailable; nothing to clear.
  }
}

function readStoredRuns(key: string, logTag: string): StoredRuns | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Record<keyof StoredRuns | 'runId', unknown>>
    const runIds = Array.isArray(parsed.runIds)
      ? [...new Set(parsed.runIds.filter(isValidRunId))].slice(0, MAX_STORED_RUNS)
      : []
    const valid =
      typeof parsed.startedAt === 'number' &&
      typeof parsed.searchSignature === 'string' &&
      parsed.searchSignature.length > 0 &&
      typeof parsed.filters === 'object' &&
      parsed.filters !== null &&
      runIds.length > 0
    if (!valid) {
      // Legacy `{ runId }` / `{ runIds }` state has no signature, so it cannot be tied to any filters.
      console.info(`[${logTag}] discarding legacy or invalid saved search state`)
      clearStoredRuns(key)
      return null
    }
    return {
      runIds,
      startedAt: parsed.startedAt as number,
      searchSignature: parsed.searchSignature as string,
      filters: parsed.filters as SignatureFilters,
    }
  } catch {
    clearStoredRuns(key)
    return null
  }
}

function writeStoredRuns(key: string, runs: StoredRuns) {
  try {
    window.localStorage.setItem(key, JSON.stringify(runs))
  } catch {
    // Storage can be unavailable (private mode); the runs still complete, they just won't resume after reload.
  }
}

function isFailed(status: string | null | undefined) {
  return !!status && (FAILED_STATUSES.has(status) || status === NOT_FOUND)
}

function isTerminal(status: string | null | undefined) {
  return status === 'SUCCEEDED' || isFailed(status)
}

function isBusyPhase(phase: Yad2SearchPhase) {
  return phase !== 'idle' && phase !== 'failed'
}

export function tally(statuses: Record<string, string | null>, startFailures: number): RunTally {
  const result: RunTally = { active: 0, succeeded: 0, failed: startFailures, total: startFailures }
  for (const status of Object.values(statuses)) {
    result.total += 1
    if (status === 'SUCCEEDED') result.succeeded += 1
    else if (isFailed(status)) result.failed += 1
    // Unknown (not yet checked / transient error) counts as active so we keep waiting for it.
    else result.active += 1
  }
  return result
}

function summarize(t: RunTally, fallback: string | null) {
  if (t.total <= 1) return fallback
  const done = t.succeeded + t.failed
  return `${done}/${t.total} done${t.failed > 0 ? ` · ${t.failed} failed` : ''}`
}

/**
 * Tracks at most one background update (its Apify runs) for ONE source. Each source uses its own hook instance,
 * storage key, run IDs and state, so Yad2 and Madlan never touch each other's status. The update never blocks the
 * dashboard: existing Supabase listings stay filterable while it runs.
 */
export function useSourceRefresh(
  config: SourceRefreshConfig,
  currentInput: RefreshInput,
  onImported: () => Promise<FingerprintItem[] | undefined>,
  currentListings: readonly FingerprintItem[] | undefined,
) {
  const { source, label, storageKey } = config
  const logTag = source
  const longRunningMessage = `${label} is taking longer than expected. The search is still running in the background.`
  const backgroundMessage = `${label} is still processing this search. You can leave this page and come back later.`
  const activeMessage = (elapsedMs: number, fallback: string) =>
    elapsedMs >= LONG_RUNNING_AFTER_MS ? longRunningMessage : fallback
  const searchesLabel = (t: RunTally) => (t.total > 1 ? `${t.total} ${label} searches` : `${label} search`)
  const updatingMessage = (t: RunTally) => {
    const done = t.succeeded + t.failed
    return t.total > 1
      ? `Updating ${label} in background — ${done}/${t.total} searches completed`
      : `Updating ${label} in background…`
  }

  const [state, setState] = useState<Yad2SearchState>(IDLE)
  // This source's listings when the update started: the fingerprint tells when the import landed, the snapshot gives new/updated counts.
  const baselineRef = useRef<string | null>(null)
  const baselineSnapshotRef = useRef<ReturnType<typeof snapshotListings>>(null)
  const listingsRef = useRef(currentListings)
  listingsRef.current = currentListings
  const [trackedSignature, setTrackedSignature] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [runIds, setRunIds] = useState<string[]>([])
  const startingRef = useRef(false)
  const importingRef = useRef(false)
  const startedAtRef = useRef(0)
  const statusesRef = useRef<Record<string, string | null>>({})
  const startFailuresRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  // Bumped whenever the tracked search is replaced, so stale import timers of the previous one do nothing.
  const generationRef = useRef(0)

  const currentSignature = yad2SearchSignature(currentInput)

  useEffect(() => {
    const timers = timersRef.current
    return () => timers.forEach(clearTimeout)
  }, [])

  useEffect(() => {
    const stored = readStoredRuns(storageKey, logTag)
    if (!stored) {
      console.info(`[${logTag}] no active search to restore`)
      return
    }
    const elapsed = Date.now() - stored.startedAt
    console.info(`[${logTag}] restored saved search; checking real Apify status`, {
      runIds: stored.runIds,
      filters: stored.filters,
      elapsedMs: elapsed,
    })
    startedAtRef.current = stored.startedAt
    startFailuresRef.current = 0
    statusesRef.current = Object.fromEntries(stored.runIds.map((id) => [id, null]))
    setTrackedSignature(stored.searchSignature)
    setRunIds(stored.runIds)
    setState({
      phase: 'running',
      outcome: 'running',
      runStatus: null,
      message: activeMessage(elapsed, `Resuming background ${label} update…`),
      startedAt: stored.startedAt,
      nextPollMs: pollDelayFor(elapsed),
      summary: null,
    })
    // Restore once on mount; config is a module constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // After a reload the pre-update listings are gone; the first load we see is the best available baseline.
  useEffect(() => {
    if (trackedSignature === null || baselineSnapshotRef.current || !currentListings) return
    const own = ofSource(currentListings, source)
    baselineRef.current = listingsFingerprint(own)
    baselineSnapshotRef.current = snapshotListings(own)
  }, [trackedSignature, currentListings, source])

  const clearTracking = () => {
    importingRef.current = false
    statusesRef.current = {}
    startFailuresRef.current = 0
    clearStoredRuns(storageKey)
    setRunIds([])
  }

  const failTracked = (message: string) => {
    clearTracking()
    setState({ ...IDLE, phase: 'failed', outcome: 'failed', message })
  }

  const finishImport = (t: RunTally) => {
    if (importingRef.current) return
    importingRef.current = true
    const generation = generationRef.current
    const partial = t.failed > 0
    // Stop polling but keep the stored run_ids until the re-fetch finishes, so a reload mid-import resumes it.
    setRunIds([])
    setState((prev) => ({
      ...prev,
      phase: 'importing',
      outcome: partial ? 'partial' : 'succeeded',
      runStatus: partial ? `PARTIAL · ${t.succeeded}/${t.total} succeeded` : 'SUCCEEDED',
      message: partial
        ? `${label} update finished · loading new listings… ${t.failed} of ${t.total} ${label} searches did not complete.`
        : `${label} update finished · loading new listings…`,
      nextPollMs: null,
    }))
    const finishedAt = Date.now()
    let previous: string | null = null
    let latest: FingerprintItem[] | undefined

    const refreshAt = (index: number) => {
      const wait = Math.max(0, finishedAt + IMPORT_REFRESH_DELAYS_MS[index] - Date.now())
      const timer = setTimeout(async () => {
        let count: number | null = null
        let fingerprint: string | null = null
        try {
          const refreshed = await onImported()
          if (refreshed) latest = refreshed
          count = refreshed?.length ?? null
          fingerprint = listingsFingerprint(ofSource(refreshed, source))
        } catch {
          // The listings query surfaces its own error state; keep the existing results visible.
        }
        const changed = fingerprint !== null && baselineRef.current !== null && fingerprint !== baselineRef.current
        const settled = changed && index > 0 && fingerprint === previous
        previous = fingerprint
        console.info(`[${logTag}] refreshed properties after runs (${index + 1}/${IMPORT_REFRESH_DELAYS_MS.length})`, {
          afterMs: Date.now() - finishedAt,
          propertyCount: count,
          changed,
          settled,
          tally: t,
        })
        // A newer search replaced this one; its listings are refreshed above, but it no longer owns the UI state.
        if (generation !== generationRef.current) return
        const isLast = index === IMPORT_REFRESH_DELAYS_MS.length - 1
        if (!settled && !isLast) return refreshAt(index + 1)
        clearTracking()
        setTrackedSignature(null)
        const { newCount, updatedCount } = diffListings(baselineSnapshotRef.current, ofSource(latest, source))
        baselineRef.current = null
        baselineSnapshotRef.current = null
        const summary: Yad2UpdateSummary = { newCount, updatedCount, succeeded: t.succeeded, failed: t.failed, total: t.total }
        const changes =
          newCount === null
            ? 'Listings refreshed with the latest import.'
            : `${newCount} new listing${newCount === 1 ? '' : 's'}, ${updatedCount} updated.`
        console.info(`[${logTag}] background update complete`, { ...summary, propertyCount: count })
        setState({
          ...IDLE,
          phase: 'done',
          outcome: partial ? 'partial' : 'succeeded',
          runStatus: partial ? `PARTIAL · ${t.succeeded}/${t.total} succeeded` : 'SUCCEEDED',
          message: `${label} update complete. ${changes}`,
          summary,
        })
        if (partial) {
          toast.warning(`${label} update completed partially`, {
            description: `${t.succeeded} of ${t.total} ${label} searches succeeded; ${t.failed} failed. ${changes}`,
          })
        } else {
          toast.success(`${label} update complete`, { description: changes })
        }
      }, wait)
      timersRef.current.push(timer)
    }
    refreshAt(0)
  }

  const pollKey = runIds.length > 0 ? [`${source}-runs`, ...runIds] : null

  useSWR(
    pollKey,
    async ([, ...ids]: string[]) => {
      // Only re-check runs that have not reached a terminal status yet; all in parallel.
      const pending = ids.filter((id) => !isTerminal(statusesRef.current[id]))
      const results = await Promise.all(
        pending.map(async (id): Promise<[string, RunStatusResult]> => {
          try {
            return [id, await config.check(id)]
          } catch {
            return [id, { ok: false, message: 'Status request failed.' }]
          }
        }),
      )
      return results
    },
    {
      // Re-evaluated after every check, so the interval backs off as the runs age and stops at 60 minutes.
      refreshInterval: () => pollDelayFor(Date.now() - startedAtRef.current),
      // Once background polling stops, returning to the tab still re-checks the real status.
      revalidateOnFocus: state.phase === 'background',
      dedupingInterval: 0,
      onSuccess: (results) => {
        const elapsed = Date.now() - startedAtRef.current
        const nextPollMs = pollDelayFor(elapsed)
        let transientErrors = 0

        for (const [id, result] of results) {
          if (result.ok) statusesRef.current[id] = result.status
          else if (UNKNOWN_RUN_ERRORS.has(result.message)) statusesRef.current[id] = NOT_FOUND
          else transientErrors += 1 // A failed status request is not a failed run; retry next tick.
        }

        const t = tally(statusesRef.current, startFailuresRef.current)
        console.info(`[${logTag}] run statuses`, { statuses: { ...statusesRef.current }, tally: t, elapsedMs: elapsed })

        if (t.active === 0) {
          if (t.succeeded > 0) return finishImport(t)
          const allMissing = Object.values(statusesRef.current).every((s) => s === NOT_FOUND)
          return failTracked(
            allMissing
              ? `The saved ${label} search could not be found on Apify. You can start a new search.`
              : `The ${searchesLabel(t)} ended without success. Your current listings are unchanged.`,
          )
        }

        const runningStatus = Object.values(statusesRef.current).find((s) => s && ACTIVE_STATUSES.has(s)) ?? null
        const runStatus = summarize(t, runningStatus)

        if (elapsed >= BACKGROUND_AFTER_MS) {
          setState((prev) => ({
            ...prev,
            phase: 'background',
            outcome: 'running',
            runStatus,
            message: backgroundMessage,
            nextPollMs: null,
          }))
          return
        }
        setState((prev) => ({
          ...prev,
          phase: 'running',
          outcome: 'running',
          runStatus,
          message:
            transientErrors > 0 && transientErrors === results.length
              ? `Having trouble reaching ${label}. Retrying…`
              : activeMessage(elapsed, updatingMessage(t)),
          nextPollMs,
        }))
      },
      onError: () => {
        const nextPollMs = pollDelayFor(Date.now() - startedAtRef.current)
        console.warn(`[${logTag}] status requests errored; will retry`, { nextPollMs })
        setState((prev) => ({ ...prev, nextPollMs, message: `Having trouble reaching ${label}. Retrying…` }))
      },
    },
  )

  const isUpdating = isBusyPhase(state.phase)
  const isTrackingCurrent = isUpdating && trackedSignature === currentSignature

  const start = async (input: RefreshInput) => {
    const signature = yad2SearchSignature(input)
    if (startingRef.current) return
    // Only the exact same refresh is skipped; a refresh for other filters may start while one runs in the background.
    if (trackedSignature === signature && isBusyPhase(state.phase)) {
      toast.info(`${label} refresh already running`, { description: 'This search is already updating in the background.' })
      return
    }
    startingRef.current = true
    setIsStarting(true)

    let result: StartRefreshResult
    try {
      result = await config.start(input)
    } catch {
      result = {
        ok: false,
        kind: 'error',
        message: `Could not start the ${label} refresh. Your current listings are unchanged.`,
      }
    } finally {
      startingRef.current = false
      setIsStarting(false)
    }

    if (!result.ok) {
      // Refusals are informational only: listings stay usable and any tracked update keeps running untouched.
      console.info(`[${logTag}] refresh not started; previous update left untouched`, { kind: result.kind })
      if (result.kind === 'unsupported') toast.info(`${label} refresh not available`, { description: result.message })
      else toast.warning(`${label} refresh not started`, { description: result.message })
      return
    }

    if (runIds.length > 0 || importingRef.current) {
      // Older runs keep running on Apify and the webhook still imports them into Supabase;
      // they show up on this search's refresh, on window focus, or on reload.
      console.info(`[${logTag}] replacing tracked search; previous runs continue in the background`, {
        previousRunIds: Object.keys(statusesRef.current),
      })
    }
    generationRef.current += 1
    importingRef.current = false
    const own = ofSource(listingsRef.current, source)
    baselineRef.current = listingsFingerprint(own)
    baselineSnapshotRef.current = snapshotListings(own)
    startedAtRef.current = Date.now()
    startFailuresRef.current = result.startFailures
    statusesRef.current = Object.fromEntries(result.runIds.map((id) => [id, result.status]))
    writeStoredRuns(storageKey, {
      runIds: result.runIds,
      startedAt: startedAtRef.current,
      searchSignature: signature,
      filters: yad2SignatureFilters(input),
    })
    console.info(`[${logTag}] runs started; run_ids persisted with search signature`, {
      runIds: result.runIds,
      startFailures: result.startFailures,
      filters: yad2SignatureFilters(input),
    })
    if (result.startFailures > 0) {
      toast.warning(`Some ${label} searches could not start`, {
        description: result.startLimitReached
          ? `Apify concurrency limit reached for ${result.startFailures} of ${result.runIds.length + result.startFailures} searches. Tracking the rest.`
          : `${result.startFailures} of ${result.runIds.length + result.startFailures} searches failed to start. Tracking the rest.`,
      })
    }
    const t = tally(statusesRef.current, startFailuresRef.current)
    setTrackedSignature(signature)
    setRunIds(result.runIds)
    setState({
      phase: 'running',
      outcome: 'running',
      runStatus: summarize(t, result.status),
      message: updatingMessage(t),
      startedAt: startedAtRef.current,
      nextPollMs: pollDelayFor(0),
      summary: null,
    })
  }

  const dismiss = () => {
    if (state.phase === 'failed' || state.phase === 'done') setState(IDLE)
  }

  return { state, start, dismiss, isStarting, isUpdating, isTrackingCurrent }
}

export function useYad2Search(
  currentInput: RefreshInput,
  onImported: () => Promise<FingerprintItem[] | undefined>,
  currentListings: readonly FingerprintItem[] | undefined,
) {
  return useSourceRefresh(YAD2_REFRESH, currentInput, onImported, currentListings)
}
