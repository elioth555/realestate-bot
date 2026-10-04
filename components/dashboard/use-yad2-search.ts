'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { checkYad2Run, startYad2Search, type Yad2RunStatus, type Yad2SearchInput } from '@/app/actions/yad2'
import { aliasKey, normalizeCity, normalizeNeighborhood } from '@/lib/normalize'

const MINUTE = 60 * 1000
const LONG_RUNNING_AFTER_MS = 10 * MINUTE
const BACKGROUND_AFTER_MS = 60 * MINUTE
// The Apify webhook imports into Supabase right after the run ends. Offsets from run completion:
// refresh immediately, then keep checking until the data has changed and settled (or the last offset).
const IMPORT_REFRESH_DELAYS_MS = [0, 2000, 5000, 10000, 20000]
const ACTIVE_RUN_STORAGE_KEY = 'realestatebot:yad2-active-run'
const RUN_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/
const MAX_STORED_RUNS = 20

const ACTIVE_STATUSES = new Set(['READY', 'RUNNING'])
const FAILED_STATUSES = new Set(['FAILED', 'ABORTED', 'TIMED-OUT'])
// Permanent answers from the status action; retrying them would lock Search forever.
const UNKNOWN_RUN_ERRORS = new Set(['Run not found.', 'Invalid run id.'])
// Local marker for a run Apify no longer knows about; counted as failed.
const NOT_FOUND = 'NOT-FOUND'

const LONG_RUNNING_MESSAGE = 'Yad2 is taking longer than expected. The search is still running in the background.'
const BACKGROUND_MESSAGE = 'Yad2 is still processing this search. You can leave this page and come back later.'

export function pollDelayFor(elapsedMs: number) {
  if (elapsedMs < 2 * MINUTE) return 3000
  if (elapsedMs < LONG_RUNNING_AFTER_MS) return 15000
  if (elapsedMs < BACKGROUND_AFTER_MS) return 30000
  return 0
}

export type Yad2SearchPhase = 'idle' | 'starting' | 'running' | 'background' | 'importing' | 'failed'
export type Yad2SearchOutcome = 'running' | 'succeeded' | 'partial' | 'failed'

export type Yad2SearchState = {
  phase: Yad2SearchPhase
  /** Aggregated outcome across every run of the search. */
  outcome: Yad2SearchOutcome | null
  runStatus: string | null
  message: string | null
  startedAt: number | null
  nextPollMs: number | null
}

type SignatureFilters = {
  city: string
  transactionType: 'rent' | 'sale'
  neighborhoods: string[]
  minRooms: string
  maxRooms: string
  minPrice: string
  maxPrice: string
}

type StoredRuns = { runIds: string[]; startedAt: number; searchSignature: string; filters: SignatureFilters }
type RunTally = { active: number; succeeded: number; failed: number; total: number }
/** A start request for one specific signature; kept apart from the tracked runs so a refused start never clobbers them. */
type StartAttempt = { signature: string; phase: 'starting' | 'failed'; message: string }

const IDLE: Yad2SearchState = {
  phase: 'idle',
  outcome: null,
  runStatus: null,
  message: null,
  startedAt: null,
  nextPollMs: null,
}

const clean = (value: string | null | undefined) => (value ?? '').trim()

/** Canonical filters, so "Old North" and "הצפון הישן" (or "Tel Aviv" / "תל אביב יפו") share one signature. */
export function yad2SignatureFilters(input: Yad2SearchInput): SignatureFilters {
  return {
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
}

export function yad2SearchSignature(input: Yad2SearchInput) {
  const f = yad2SignatureFilters(input)
  return JSON.stringify([
    aliasKey(f.city),
    f.transactionType,
    f.neighborhoods.map(aliasKey),
    f.minRooms,
    f.maxRooms,
    f.minPrice,
    f.maxPrice,
  ])
}

type FingerprintItem = { id: string; price: number; rooms: number; surface: number }

/** Cheap content hash of the loaded listings, used to tell when the webhook import has landed and settled. */
export function listingsFingerprint(items: readonly FingerprintItem[] | undefined) {
  if (!items) return null
  let hash = 5381
  for (const l of items) {
    const s = `${l.id}:${l.price}:${l.rooms}:${l.surface};`
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  return `${items.length}:${hash}`
}

function isValidRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}

function clearStoredRuns() {
  try {
    window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY)
  } catch {
    // Storage unavailable; nothing to clear.
  }
}

function readStoredRuns(): StoredRuns | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY)
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
      console.info('[yad2] discarding legacy or invalid saved search state')
      clearStoredRuns()
      return null
    }
    return {
      runIds,
      startedAt: parsed.startedAt as number,
      searchSignature: parsed.searchSignature as string,
      filters: parsed.filters as SignatureFilters,
    }
  } catch {
    clearStoredRuns()
    return null
  }
}

function writeStoredRuns(runs: StoredRuns) {
  try {
    window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(runs))
  } catch {
    // Storage can be unavailable (private mode); the runs still complete, they just won't resume after reload.
  }
}

function activeMessage(elapsedMs: number, fallback: string) {
  return elapsedMs >= LONG_RUNNING_AFTER_MS ? LONG_RUNNING_MESSAGE : fallback
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

function searchesLabel(t: RunTally) {
  return t.total > 1 ? `${t.total} Yad2 searches` : 'Yad2 search'
}

/**
 * Tracks at most one Yad2 search (its Apify runs) together with the filter signature that started it.
 * The tracked runs keep polling and importing in the background whatever the dashboard shows;
 * the Searching state and the locked Search button only apply while `currentInput` matches that signature.
 */
export function useYad2Search(
  currentInput: Yad2SearchInput,
  onImported: () => Promise<FingerprintItem[] | undefined>,
  currentListings: readonly FingerprintItem[] | undefined,
) {
  const [state, setState] = useState<Yad2SearchState>(IDLE)
  // Listings snapshot taken when the search starts; a refresh that differs from it means the import landed.
  const baselineRef = useRef<string | null>(null)
  const listingsRef = useRef(currentListings)
  listingsRef.current = currentListings
  const [trackedSignature, setTrackedSignature] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<StartAttempt | null>(null)
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
    const stored = readStoredRuns()
    if (!stored) {
      console.info('[yad2] no active search to restore')
      return
    }
    const elapsed = Date.now() - stored.startedAt
    console.info('[yad2] restored saved search; checking real Apify status', {
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
      message: activeMessage(elapsed, 'Resuming your Yad2 search…'),
      startedAt: stored.startedAt,
      nextPollMs: pollDelayFor(elapsed),
    })
  }, [])

  const clearTracking = () => {
    importingRef.current = false
    statusesRef.current = {}
    startFailuresRef.current = 0
    clearStoredRuns()
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
        ? `Yad2 finished · loading new listings… ${t.failed} of ${t.total} Yad2 searches did not complete.`
        : 'Yad2 finished · loading new listings…',
      nextPollMs: null,
    }))
    const finishedAt = Date.now()
    let previous: string | null = null

    const refreshAt = (index: number) => {
      const wait = Math.max(0, finishedAt + IMPORT_REFRESH_DELAYS_MS[index] - Date.now())
      const timer = setTimeout(async () => {
        let count: number | null = null
        let fingerprint: string | null = null
        try {
          const refreshed = await onImported()
          count = refreshed?.length ?? null
          fingerprint = listingsFingerprint(refreshed)
        } catch {
          // The listings query surfaces its own error state; keep the existing results visible.
        }
        const changed = fingerprint !== null && baselineRef.current !== null && fingerprint !== baselineRef.current
        const settled = changed && index > 0 && fingerprint === previous
        previous = fingerprint
        console.info(`[yad2] refreshed properties after runs (${index + 1}/${IMPORT_REFRESH_DELAYS_MS.length})`, {
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
        setState(IDLE)
        const loaded =
          count === null ? 'Listings refreshed with the latest import.' : `${count} properties loaded from Supabase.`
        if (partial) {
          toast.warning('Yad2 search completed partially', {
            description: `${t.succeeded} of ${t.total} Yad2 searches succeeded; ${t.failed} failed. ${loaded}`,
          })
        } else {
          toast.success('Yad2 search complete', { description: loaded })
        }
      }, wait)
      timersRef.current.push(timer)
    }
    refreshAt(0)
  }

  const pollKey = runIds.length > 0 ? ['yad2-runs', ...runIds] : null

  useSWR(
    pollKey,
    async ([, ...ids]: string[]) => {
      // Only re-check runs that have not reached a terminal status yet; all in parallel.
      const pending = ids.filter((id) => !isTerminal(statusesRef.current[id]))
      const results = await Promise.all(
        pending.map(async (id): Promise<[string, Yad2RunStatus]> => {
          try {
            return [id, await checkYad2Run(id)]
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
        console.info('[yad2] run statuses', { statuses: { ...statusesRef.current }, tally: t, elapsedMs: elapsed })

        if (t.active === 0) {
          if (t.succeeded > 0) return finishImport(t)
          const allMissing = Object.values(statusesRef.current).every((s) => s === NOT_FOUND)
          return failTracked(
            allMissing
              ? 'The saved Yad2 search could not be found on Apify. You can start a new search.'
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
            message: BACKGROUND_MESSAGE,
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
              ? 'Having trouble reaching Yad2. Retrying…'
              : activeMessage(elapsed, `Searching Yad2 for new listings${t.total > 1 ? ` (${t.total} searches)` : ''}…`),
          nextPollMs,
        }))
      },
      onError: () => {
        const nextPollMs = pollDelayFor(Date.now() - startedAtRef.current)
        console.warn('[yad2] status requests errored; will retry', { nextPollMs })
        setState((prev) => ({ ...prev, nextPollMs, message: 'Having trouble reaching Yad2. Retrying…' }))
      },
    },
  )

  let visible: Yad2SearchState = IDLE
  if (attempt && attempt.signature === currentSignature) {
    visible =
      attempt.phase === 'starting'
        ? { ...IDLE, phase: 'starting', outcome: 'running', message: attempt.message }
        : { ...IDLE, phase: 'failed', outcome: 'failed', message: attempt.message }
  } else if (trackedSignature === currentSignature) {
    visible = state
  }
  const isSearching = isBusyPhase(visible.phase)

  const start = async (input: Yad2SearchInput) => {
    const signature = yad2SearchSignature(input)
    // Only the exact same search is blocked; a different search may start while an older one runs in the background.
    if (startingRef.current) return
    if (trackedSignature === signature && isBusyPhase(state.phase)) return
    startingRef.current = true
    setAttempt({ signature, phase: 'starting', message: 'Starting Yad2 search…' })

    let result: Awaited<ReturnType<typeof startYad2Search>>
    try {
      result = await startYad2Search(input)
    } catch {
      result = { ok: false, kind: 'error', message: 'Could not start the Yad2 search. Your current listings are unchanged.' }
    } finally {
      startingRef.current = false
    }

    if (!result.ok) {
      if (result.kind === 'unsupported') {
        setAttempt(null)
        toast.info('Filtered imported listings only', { description: result.message })
        return
      }
      // The previously tracked search (if any) is left untouched and keeps running in the background.
      console.info('[yad2] start refused; previous search left untouched', { kind: result.kind })
      setAttempt({ signature, phase: 'failed', message: result.message })
      return
    }

    if (runIds.length > 0 || importingRef.current) {
      // Older runs keep running on Apify and the webhook still imports them into Supabase;
      // they show up on this search's refresh, on window focus, or on reload.
      console.info('[yad2] replacing tracked search; previous runs continue in the background', {
        previousRunIds: Object.keys(statusesRef.current),
      })
    }
    generationRef.current += 1
    importingRef.current = false
    baselineRef.current = listingsFingerprint(listingsRef.current)
    startedAtRef.current = Date.now()
    startFailuresRef.current = result.startFailures
    statusesRef.current = Object.fromEntries(result.runIds.map((id) => [id, result.status]))
    writeStoredRuns({
      runIds: result.runIds,
      startedAt: startedAtRef.current,
      searchSignature: signature,
      filters: yad2SignatureFilters(input),
    })
    console.info('[yad2] runs started; run_ids persisted with search signature', {
      runIds: result.runIds,
      startFailures: result.startFailures,
      filters: yad2SignatureFilters(input),
    })
    if (result.startFailures > 0) {
      toast.warning('Some Yad2 searches could not start', {
        description: result.startLimitReached
          ? `Apify concurrency limit reached for ${result.startFailures} of ${result.runIds.length + result.startFailures} searches. Tracking the rest.`
          : `${result.startFailures} of ${result.runIds.length + result.startFailures} searches failed to start. Tracking the rest.`,
      })
    }
    const t = tally(statusesRef.current, startFailuresRef.current)
    setAttempt(null)
    setTrackedSignature(signature)
    setRunIds(result.runIds)
    setState({
      phase: 'running',
      outcome: 'running',
      runStatus: summarize(t, result.status),
      message: `Searching Yad2 for new listings${t.total > 1 ? ` (${t.total} searches)` : ''}…`,
      startedAt: startedAtRef.current,
      nextPollMs: pollDelayFor(0),
    })
  }

  const dismiss = () => {
    if (attempt && attempt.signature === currentSignature && attempt.phase === 'failed') setAttempt(null)
    else if (trackedSignature === currentSignature && state.phase === 'failed') setState(IDLE)
  }

  return { state: visible, start, dismiss, isSearching }
}
