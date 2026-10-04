'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { checkYad2Run, startYad2Search, type Yad2RunStatus, type Yad2SearchInput } from '@/app/actions/yad2'

const MINUTE = 60 * 1000
const LONG_RUNNING_AFTER_MS = 10 * MINUTE
const BACKGROUND_AFTER_MS = 60 * MINUTE
// The Apify webhook imports into Supabase after the run ends; refresh twice to catch slower imports.
const IMPORT_REFRESH_DELAYS_MS = [8000, 20000]
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
  if (elapsedMs < 2 * MINUTE) return 5000
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

type StoredRuns = { runIds: string[]; startedAt: number }
type RunTally = { active: number; succeeded: number; failed: number; total: number }

const IDLE: Yad2SearchState = {
  phase: 'idle',
  outcome: null,
  runStatus: null,
  message: null,
  startedAt: null,
  nextPollMs: null,
}

function isValidRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}

function readStoredRuns(): StoredRuns | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { runIds?: unknown; runId?: unknown; startedAt?: unknown }
    if (typeof parsed.startedAt !== 'number') return null
    // Older saved state held a single `runId`.
    const candidates = Array.isArray(parsed.runIds) ? parsed.runIds : parsed.runId !== undefined ? [parsed.runId] : []
    const runIds = [...new Set(candidates.filter(isValidRunId))].slice(0, MAX_STORED_RUNS)
    if (runIds.length === 0) return null
    return { runIds, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

function writeStoredRuns(runs: StoredRuns | null) {
  try {
    if (runs) window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(runs))
    else window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY)
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

export function useYad2Search(onImported: () => Promise<unknown[] | undefined>) {
  const [state, setState] = useState<Yad2SearchState>(IDLE)
  const [runIds, setRunIds] = useState<string[]>([])
  const busyRef = useRef(false)
  const importingRef = useRef(false)
  const startedAtRef = useRef(0)
  const statusesRef = useRef<Record<string, string | null>>({})
  const startFailuresRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    const timers = timersRef.current
    return () => timers.forEach(clearTimeout)
  }, [])

  useEffect(() => {
    const stored = readStoredRuns()
    if (!stored) {
      console.info('[yad2] no active runs to restore')
      return
    }
    const elapsed = Date.now() - stored.startedAt
    console.info('[yad2] restored run_ids after reload; checking real Apify status', { ...stored, elapsedMs: elapsed })
    // Normalizes legacy `{ runId }` state into the `{ runIds }` shape.
    writeStoredRuns(stored)
    busyRef.current = true
    startedAtRef.current = stored.startedAt
    startFailuresRef.current = 0
    statusesRef.current = Object.fromEntries(stored.runIds.map((id) => [id, null]))
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

  const reset = () => {
    busyRef.current = false
    importingRef.current = false
    statusesRef.current = {}
    startFailuresRef.current = 0
    writeStoredRuns(null)
    setRunIds([])
  }

  const fail = (message: string) => {
    reset()
    setState({ ...IDLE, phase: 'failed', outcome: 'failed', message })
  }

  const finishImport = (t: RunTally) => {
    if (importingRef.current) return
    importingRef.current = true
    const partial = t.failed > 0
    // Stop polling but keep the stored run_ids until the re-fetch finishes, so a reload mid-import resumes it.
    setRunIds([])
    setState((prev) => ({
      ...prev,
      phase: 'importing',
      outcome: partial ? 'partial' : 'succeeded',
      runStatus: partial ? `PARTIAL · ${t.succeeded}/${t.total} succeeded` : 'SUCCEEDED',
      message: partial
        ? `Importing new Yad2 listings… ${t.failed} of ${t.total} Yad2 searches did not complete.`
        : 'Importing new Yad2 listings…',
      nextPollMs: null,
    }))
    IMPORT_REFRESH_DELAYS_MS.forEach((delay, index) => {
      const timer = setTimeout(async () => {
        let count: number | null = null
        try {
          const refreshed = await onImported()
          count = refreshed?.length ?? null
        } catch {
          // The listings query surfaces its own error state; keep the existing results visible.
        }
        console.info(`[yad2] refreshed properties after runs (${index + 1}/${IMPORT_REFRESH_DELAYS_MS.length})`, {
          propertyCount: count,
          tally: t,
        })
        if (index === IMPORT_REFRESH_DELAYS_MS.length - 1) {
          reset()
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
        }
      }, delay)
      timersRef.current.push(timer)
    })
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
          return fail(
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

  const start = async (input: Yad2SearchInput) => {
    if (busyRef.current) return
    busyRef.current = true
    setState({ ...IDLE, phase: 'starting', outcome: 'running', message: 'Starting Yad2 search…' })

    let result: Awaited<ReturnType<typeof startYad2Search>>
    try {
      result = await startYad2Search(input)
    } catch {
      return fail('Could not start the Yad2 search. Your current listings are unchanged.')
    }

    if (!result.ok) {
      if (result.kind === 'unsupported') {
        busyRef.current = false
        setState(IDLE)
        toast.info('Filtered imported listings only', { description: result.message })
        return
      }
      return fail(result.message)
    }

    startedAtRef.current = Date.now()
    startFailuresRef.current = result.startFailures
    statusesRef.current = Object.fromEntries(result.runIds.map((id) => [id, result.status]))
    writeStoredRuns({ runIds: result.runIds, startedAt: startedAtRef.current })
    console.info('[yad2] runs started; run_ids persisted', {
      runIds: result.runIds,
      startFailures: result.startFailures,
    })
    if (result.startFailures > 0) {
      toast.warning('Some Yad2 searches could not start', {
        description: result.startLimitReached
          ? `Apify concurrency limit reached for ${result.startFailures} of ${result.runIds.length + result.startFailures} searches. Tracking the rest.`
          : `${result.startFailures} of ${result.runIds.length + result.startFailures} searches failed to start. Tracking the rest.`,
      })
    }
    const t = tally(statusesRef.current, startFailuresRef.current)
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
    if (state.phase === 'failed') setState(IDLE)
  }

  return { state, start, dismiss, isSearching: state.phase !== 'idle' && state.phase !== 'failed' }
}
