'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Clock, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Yad2SearchState } from './use-yad2-search'

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function Yad2SearchStatus({ state, onDismiss }: { state: Yad2SearchState; onDismiss: () => void }) {
  const showsDiagnostics = state.phase !== 'idle' && state.phase !== 'failed' && state.startedAt !== null
  const now = useNow(showsDiagnostics)

  if (state.phase === 'idle') return null

  if (state.phase === 'failed') {
    return (
      <div
        role="alert"
        className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
      >
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <p className="flex-1 leading-relaxed text-foreground">{state.message}</p>
        <Button variant="ghost" size="icon" className="-my-1 size-7" onClick={onDismiss} aria-label="Dismiss message">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
    )
  }

  const isBackground = state.phase === 'background'
  const nextPollLabel = isBackground
    ? 'checks paused · re-checks on return'
    : state.nextPollMs
      ? `next check in ${Math.round(state.nextPollMs / 1000)}s`
      : null

  return (
    <div role="status" aria-live="polite" className="mb-4 flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        {isBackground ? (
          <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
        )}
        <p className="flex-1 leading-relaxed text-foreground">{state.message}</p>
        {state.runStatus && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
            {state.runStatus}
          </span>
        )}
      </div>
      {showsDiagnostics && state.startedAt !== null && (
        <p className="pl-7 text-xs text-muted-foreground tabular-nums">
          {`Status: ${state.runStatus ?? 'checking…'} · elapsed ${formatElapsed(now - state.startedAt)}`}
          {nextPollLabel ? ` · ${nextPollLabel}` : ''}
        </p>
      )}
    </div>
  )
}
