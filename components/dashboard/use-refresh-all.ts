'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  REFRESH_SESSION_KEY,
  REFRESH_SOURCES,
  parseSession,
  sourceProgress,
  sourcesToStart,
  startSourcesInParallel,
  summarizeRefresh,
  terminalResult,
  type RefreshSession,
  type SourceKey,
  type SourceProgress,
  type SourceSnapshot,
} from '@/lib/refresh-all'
import type { RefreshInput, SourceRefreshHook } from './use-yad2-search'

function writeSession(session: RefreshSession | null) {
  try {
    if (session) window.localStorage.setItem(REFRESH_SESSION_KEY, JSON.stringify(session))
    else window.localStorage.removeItem(REFRESH_SESSION_KEY)
  } catch {
    // Storage unavailable; the runs still complete, the progress line just won't survive a reload.
  }
}

/**
 * One "Refresh all sources" action over the three independent source hooks. Each hook keeps its own run IDs,
 * storage key, polling and Supabase refetch; this only starts them together and folds their state into one line.
 */
export function useRefreshAll(
  hooks: Record<SourceKey, SourceRefreshHook>,
  inputs: Record<SourceKey, RefreshInput>,
) {
  const [session, setSession] = useState<RefreshSession | null>(null)
  // Sources whose start request has not answered yet; pending regardless of their hook phase.
  const [launching, setLaunching] = useState<ReadonlySet<SourceKey>>(() => new Set())

  const persist = (next: RefreshSession | null) => {
    setSession(next)
    writeSession(next)
  }

  // Declared after the source hooks, so it runs in the same commit as their run-ID restore.
  useEffect(() => {
    const restored = parseSession(window.localStorage.getItem(REFRESH_SESSION_KEY))
    if (restored) console.info('[refresh-all] restored refresh session', restored)
    setSession(restored)
  }, [])

  const snapshots = Object.fromEntries(
    REFRESH_SOURCES.map((k) => [k, { phase: hooks[k].state.phase, isStarting: hooks[k].isStarting || launching.has(k) }]),
  ) as Record<SourceKey, SourceSnapshot>

  const phases = REFRESH_SOURCES.map((k) => `${snapshots[k].phase}:${snapshots[k].isStarting}`).join('|')

  // Record each source's result the moment its own hook finishes, so it survives later dismisses and reloads.
  useEffect(() => {
    if (!session) return
    const outcomes = { ...session.outcomes }
    let changed = false
    for (const k of session.sources) {
      if (outcomes[k] || snapshots[k].isStarting) continue
      const result = terminalResult(snapshots[k].phase)
      if (result) {
        outcomes[k] = result
        changed = true
      }
    }
    if (changed) persist({ ...session, outcomes })
    // `phases` captures every snapshot field read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, phases])

  const progress = session
    ? (Object.fromEntries(REFRESH_SOURCES.map((k) => [k, sourceProgress(k, session, snapshots[k])])) as Record<
        SourceKey,
        SourceProgress
      >)
    : null
  const summary = session && progress ? summarizeRefresh(session, progress) : null
  const isRefreshing = summary?.active ?? false

  const newListings = summary
    ? summary.updated.reduce<number | null>((sum, k) => {
        const n = hooks[k].state.summary?.newCount
        return typeof n === 'number' ? (sum ?? 0) + n : sum
      }, null)
    : null

  const refreshAll = async () => {
    if (isRefreshing || launching.size > 0) {
      toast.info('Refresh already running', { description: 'Sources are still updating in the background.' })
      return
    }
    const toStart = sourcesToStart(snapshots)
    const attached = REFRESH_SOURCES.filter((k) => !toStart.includes(k))
    const next: RefreshSession = { startedAt: Date.now(), sources: [...REFRESH_SOURCES], outcomes: {} }
    console.info('[refresh-all] starting sources in parallel', { start: toStart, attachedToActiveRun: attached })
    for (const k of toStart) hooks[k].dismiss()
    setLaunching(new Set(toStart))
    persist(next)

    const outcomes = await startSourcesInParallel(toStart, (k) => hooks[k].start(inputs[k]))
    const refused = toStart.filter((k) => outcomes[k] === 'refused')
    console.info('[refresh-all] start results', outcomes)
    setLaunching(new Set())
    if (refused.length > 0) {
      setSession((current) => {
        if (!current || current.startedAt !== next.startedAt) return current
        const updated: RefreshSession = { ...current, outcomes: { ...current.outcomes } }
        for (const k of refused) updated.outcomes[k] = 'failed'
        writeSession(updated)
        return updated
      })
    }
  }

  const dismiss = () => {
    if (summary && !summary.active) persist(null)
  }

  return { summary, isRefreshing: isRefreshing || launching.size > 0, newListings, refreshAll, dismiss }
}
