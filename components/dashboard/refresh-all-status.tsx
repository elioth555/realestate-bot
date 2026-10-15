'use client'

import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { RefreshSummary } from '@/lib/refresh-all'
import { cn } from '@/lib/utils'

export function RefreshAllStatus({
  summary,
  newListings,
  onDismiss,
}: {
  summary: RefreshSummary | null
  newListings: number | null
  onDismiss: () => void
}) {
  if (!summary) return null
  const partial = !summary.active && summary.failed.length > 0
  const Icon = summary.active ? Loader2 : partial ? AlertCircle : CheckCircle2
  const extra = [
    summary.detail,
    !summary.active && newListings !== null ? `${newListings} new listing${newListings === 1 ? '' : 's'}` : null,
  ].filter(Boolean)

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm"
    >
      <Icon
        className={cn(
          'size-4 shrink-0',
          summary.active ? 'animate-spin text-muted-foreground' : partial ? 'text-destructive' : 'text-primary',
        )}
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 text-pretty">
        <span className="font-medium text-foreground">{summary.title}</span>
        {extra.length > 0 && <span className="text-muted-foreground">{` · ${extra.join(' · ')}`}</span>}
      </p>
      {!summary.active && (
        <Button type="button" variant="ghost" size="icon" className="size-7" onClick={onDismiss}>
          <X className="size-4" aria-hidden="true" />
          <span className="sr-only">Dismiss refresh status</span>
        </Button>
      )}
    </div>
  )
}
