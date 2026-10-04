'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { checkYad2Run, startYad2Search, type Yad2SearchInput } from '@/app/actions/yad2'

export const POLL_INTERVAL_MS = 5000
const MAX_WATCH_MS = 10 * 60 * 1000
const MAX_CONSECUTIVE_POLL_ERRORS = 3
// The Apify webhook imports into Supabase after the run ends; refresh twice to catch slower imports.
const IMPORT_REFRESH_DELAYS_MS = [8000, 20000]
const ACTIVE_RUN_STORAGE_KEY = 'realestatebot:yad2-active-run'

const FAILED_STATUSES = new Set(['FAILED', 'ABORTED', 'TIMED-OUT'])

export type Yad2SearchPhase = 'idle' | 'starting' | 'running' | 'importing' | 'failed'

export type Yad2SearchState = {
  phase: Yad2SearchPhase
  runStatus: string | null
  message: string | null
}

type StoredRun = { runId: string; startedAt: number }

const IDLE: Yad2SearchState = { phase: 'idle', runStatus: null, message: null }

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

export function useYad2Search(onImported: () => Promise<unknown[] | undefined>) {
  const [state, setState] = useState<Yad2SearchState>(IDLE)
  const [runId, setRunId] = useState<string | null>(null)
  const busyRef = useRef(false)
  const importingRef = useRef(false)
  const startedAtRef = useRef(0)
  const pollErrorsRef = useRef(0)
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
    if (Date.now() - stored.startedAt > MAX_WATCH_MS) {
      console.info('[yad2] stored run is older than the watch window; discarding', stored)
      writeStoredRun(null)
      return
    }
    console.info('[yad2] restored run_id after reload; resuming status checks', stored)
    busyRef.current = true
    startedAtRef.current = stored.startedAt
    pollErrorsRef.current = 0
    setRunId(stored.runId)
    setState({ phase: 'running', runStatus: null, message: 'Resuming your Yad2 search…' })
  }, [])

  const fail = (message: string) => {
    busyRef.current = false
    importingRef.current = false
    writeStoredRun(null)
    setRunId(null)
    setState({ phase: 'failed', runStatus: null, message })
  }

  const finishImport = () => {
    if (importingRef.current) return
    importingRef.current = true
    // Stop polling but keep the stored run_id until the re-fetch finishes, so a reload mid-import resumes it.
    setRunId(null)
    setState({ phase: 'importing', runStatus: 'SUCCEEDED', message: 'Importing new Yad2 listings…' })
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
    refreshInterval: POLL_INTERVAL_MS,
    revalidateOnFocus: false,
    dedupingInterval: 0,
    onSuccess: (result) => {
      if (!result.ok) {
        pollErrorsRef.current += 1
        if (pollErrorsRef.current >= MAX_CONSECUTIVE_POLL_ERRORS) fail(`Could not check the Yad2 search: ${result.message}`)
        return
      }
      pollErrorsRef.current = 0
      if (result.status === 'SUCCEEDED') return finishImport()
      if (FAILED_STATUSES.has(result.status)) {
        return fail(`The Yad2 search ended with status ${result.status}. Your current listings are unchanged.`)
      }
      if (Date.now() - startedAtRef.current > MAX_WATCH_MS) {
        return fail('The Yad2 search is taking longer than 10 minutes. New listings will appear once it finishes.')
      }
      setState((prev) => ({ ...prev, runStatus: result.status, message: 'Searching Yad2 for new listings…' }))
    },
    onError: () => {
      pollErrorsRef.current += 1
      if (pollErrorsRef.current >= MAX_CONSECUTIVE_POLL_ERRORS) fail('Lost connection while checking the Yad2 search.')
    },
  })

  const start = async (input: Yad2SearchInput) => {
    if (busyRef.current) return
    busyRef.current = true
    setState({ phase: 'starting', runStatus: null, message: 'Starting Yad2 search…' })

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
    pollErrorsRef.current = 0
    writeStoredRun({ runId: result.runId, startedAt: startedAtRef.current })
    console.info('[yad2] run started; run_id persisted', { runId: result.runId, reused: result.reusedActiveRun })
    setRunId(result.runId)
    setState({
      phase: 'running',
      runStatus: result.status,
      message: result.reusedActiveRun
        ? 'A Yad2 search was already running. Waiting for it to finish…'
        : 'Searching Yad2 for new listings…',
    })
  }

  const dismiss = () => {
    if (state.phase === 'failed') setState(IDLE)
  }

  return { state, start, dismiss, isSearching: state.phase !== 'idle' && state.phase !== 'failed' }
}
