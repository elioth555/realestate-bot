'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { checkYad2Run, startYad2Search, type Yad2SearchInput } from '@/app/actions/yad2'

const MINUTE = 60 * 1000
const LONG_RUNNING_AFTER_MS = 10 * MINUTE
const BACKGROUND_AFTER_MS = 60 * MINUTE
// The Apify webhook imports into Supabase after the run ends; refresh twice to catch slower imports.
const IMPORT_REFRESH_DELAYS_MS = [8000, 20000]
const ACTIVE_RUN_STORAGE_KEY = 'realestatebot:yad2-active-run'

const FAILED_STATUSES = new Set(['FAILED', 'ABORTED', 'TIMED-OUT'])
// Permanent answers from the status action; retrying them would lock Search forever.
const UNKNOWN_RUN_ERRORS = new Set(['Run not found.', 'Invalid run id.'])

const LONG_RUNNING_MESSAGE = 'Yad2 is taking longer than expected. The search is still running in the background.'
const BACKGROUND_MESSAGE = 'Yad2 is still processing this search. You can leave this page and come back later.'

export function pollDelayFor(elapsedMs: number) {
  if (elapsedMs < 2 * MINUTE) return 5000
  if (elapsedMs < LONG_RUNNING_AFTER_MS) return 15000
  if (elapsedMs < BACKGROUND_AFTER_MS) return 30000
  return 0
}

export type Yad2SearchPhase = 'idle' | 'starting' | 'running' | 'background' | 'importing' | 'failed'

export type Yad2SearchState = {
  phase: Yad2SearchPhase
  runStatus: string | null
  message: string | null
  startedAt: number | null
  nextPollMs: number | null
}

type StoredRun = { runId: string; startedAt: number }

const IDLE: Yad2SearchState = { phase: 'idle', runStatus: null, message: null, startedAt: null, nextPollMs: null }

function readStoredRun(): StoredRun | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredRun>
    if (typeof parsed.runId !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(parsed.runId)) return null
    if (typeof parsed.startedAt !== 'number') return null
    return { runId: parsed.runId, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

function writeStoredRun(run: StoredRun | null) {
  try {
    if (run) window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(run))
    else window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY)
  } catch {
    // Storage can be unavailable (private mode); the run still completes, it just won't resume after reload.
  }
}

function activeMessage(elapsedMs: number, fallback: string) {
  return elapsedMs >= LONG_RUNNING_AFTER_MS ? LONG_RUNNING_MESSAGE : fallback
}

export function useYad2Search(onImported: () => Promise<unknown[] | undefined>) {
  const [state, setState] = useState<Yad2SearchState>(IDLE)
  const [runId, setRunId] = useState<string | null>(null)
  const busyRef = useRef(false)
  const importingRef = useRef(false)
  const startedAtRef = useRef(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    const timers = timersRef.current
    return () => timers.forEach(clearTimeout)
  }, [])

  useEffect(() => {
    const stored = readStoredRun()
    if (!stored) {
      console.info('[yad2] no active run to restore')
      return
    }
    const elapsed = Date.now() - stored.startedAt
    console.info('[yad2] restored run_id after reload; checking real Apify status', { ...stored, elapsedMs: elapsed })
    busyRef.current = true
    startedAtRef.current = stored.startedAt
    setRunId(stored.runId)
    setState({
      phase: 'running',
      runStatus: null,
      message: activeMessage(elapsed, 'Resuming your Yad2 search…'),
      startedAt: stored.startedAt,
      nextPollMs: pollDelayFor(elapsed),
    })
  }, [])

  const fail = (message: string) => {
    busyRef.current = false
    importingRef.current = false
    writeStoredRun(null)
    setRunId(null)
    setState({ ...IDLE, phase: 'failed', message })
  }

  const finishImport = () => {
    if (importingRef.current) return
    importingRef.current = true
    // Stop polling but keep the stored run_id until the re-fetch finishes, so a reload mid-import resumes it.
    setRunId(null)
    setState((prev) => ({
      ...prev,
      phase: 'importing',
      runStatus: 'SUCCEEDED',
      message: 'Importing new Yad2 listings…',
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
        console.info(`[yad2] refreshed properties after run (${index + 1}/${IMPORT_REFRESH_DELAYS_MS.length})`, {
          propertyCount: count,
        })
        if (index === IMPORT_REFRESH_DELAYS_MS.length - 1) {
          busyRef.current = false
          importingRef.current = false
          writeStoredRun(null)
          setState(IDLE)
          toast.success('Yad2 search complete', {
            description:
              count === null ? 'Listings refreshed with the latest import.' : `${count} properties loaded from Supabase.`,
          })
        }
      }, delay)
      timersRef.current.push(timer)
    })
  }

  useSWR(runId ? ['yad2-run', runId] : null, ([, id]) => checkYad2Run(id), {
    // Re-evaluated after every check, so the interval backs off as the run ages and stops at 60 minutes.
    refreshInterval: () => pollDelayFor(Date.now() - startedAtRef.current),
    // Once background polling stops, returning to the tab still re-checks the real status.
    revalidateOnFocus: state.phase === 'background',
    dedupingInterval: 0,
    onSuccess: (result) => {
      const elapsed = Date.now() - startedAtRef.current
      const nextPollMs = pollDelayFor(elapsed)

      if (!result.ok) {
        if (UNKNOWN_RUN_ERRORS.has(result.message)) {
          return fail('The saved Yad2 search could not be found on Apify. You can start a new search.')
        }
        // A failed status request is not a failed run; keep the run_id and try again on the next tick.
        console.warn('[yad2] status check failed; will retry', { message: result.message, nextPollMs })
        setState((prev) => ({ ...prev, nextPollMs, message: 'Having trouble reaching Yad2. Retrying…' }))
        return
      }

      console.info('[yad2] run status', { status: result.status, elapsedMs: elapsed, nextPollMs })
      if (result.status === 'SUCCEEDED') return finishImport()
      if (FAILED_STATUSES.has(result.status)) {
        return fail(`The Yad2 search ended with status ${result.status}. Your current listings are unchanged.`)
      }

      if (elapsed >= BACKGROUND_AFTER_MS) {
        setState((prev) => ({
          ...prev,
          phase: 'background',
          runStatus: result.status,
          message: BACKGROUND_MESSAGE,
          nextPollMs: null,
        }))
        return
      }
      setState((prev) => ({
        ...prev,
        phase: 'running',
        runStatus: result.status,
        message: activeMessage(elapsed, 'Searching Yad2 for new listings…'),
        nextPollMs,
      }))
    },
    onError: () => {
      const nextPollMs = pollDelayFor(Date.now() - startedAtRef.current)
      console.warn('[yad2] status request errored; will retry', { nextPollMs })
      setState((prev) => ({ ...prev, nextPollMs, message: 'Having trouble reaching Yad2. Retrying…' }))
    },
  })

  const start = async (input: Yad2SearchInput) => {
    if (busyRef.current) return
    busyRef.current = true
    setState({ ...IDLE, phase: 'starting', message: 'Starting Yad2 search…' })

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
    writeStoredRun({ runId: result.runId, startedAt: startedAtRef.current })
    console.info('[yad2] run started; run_id persisted', { runId: result.runId, reused: result.reusedActiveRun })
    setRunId(result.runId)
    setState({
      phase: 'running',
      runStatus: result.status,
      message: result.reusedActiveRun
        ? 'A Yad2 search was already running. Waiting for it to finish…'
        : 'Searching Yad2 for new listings…',
      startedAt: startedAtRef.current,
      nextPollMs: pollDelayFor(0),
    })
  }

  const dismiss = () => {
    if (state.phase === 'failed') setState(IDLE)
  }

  return { state, start, dismiss, isSearching: state.phase !== 'idle' && state.phase !== 'failed' }
}
