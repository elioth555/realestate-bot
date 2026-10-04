import { AlertCircle, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Yad2SearchState } from './use-yad2-search'

export function Yad2SearchStatus({ state, onDismiss }: { state: Yad2SearchState; onDismiss: () => void }) {
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

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm"
    >
      <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
      <p className="flex-1 text-foreground">{state.message}</p>
      {state.runStatus && (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
          {state.runStatus}
        </span>
      )}
    </div>
  )
}
