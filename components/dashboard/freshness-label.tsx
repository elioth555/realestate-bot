import { cn } from '@/lib/utils'
import type { FreshnessStatus } from '@/lib/freshness'
import { FRESHNESS_DESCRIPTIONS, FRESHNESS_LABELS } from '@/lib/listing-freshness'

const DOT: Record<FreshnessStatus, string> = {
  active: 'bg-primary',
  legacy: 'bg-muted-foreground/40',
  stale: 'bg-muted-foreground',
  inactive: 'bg-destructive',
}

export function FreshnessLabel({ status, className }: { status: FreshnessStatus; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}
      title={FRESHNESS_DESCRIPTIONS[status]}
    >
      <span className={cn('inline-block size-1.5 rounded-full', DOT[status])} aria-hidden="true" />
      {FRESHNESS_LABELS[status]}
    </span>
  )
}
