import { cn } from '@/lib/utils'
import { SOURCE_LABELS, type Source } from '@/lib/listings'

const DOT: Record<Source, string> = {
  facebook: 'bg-[#1877F2]',
  yad2: 'bg-[#FF7100]',
  madlan: 'bg-[#10B981]',
  other: 'bg-muted-foreground',
}

export function SourceDot({ source, className }: { source: Source; className?: string }) {
  return <span className={cn('inline-block size-2 rounded-full', DOT[source], className)} aria-hidden="true" />
}

/** One pill for a single source; one combined pill ("Facebook · Yad2") when a card merges several. */
export function SourceBadges({ sources }: { sources: Source[] }) {
  if (sources.length <= 1) return <SourceBadge source={sources[0] ?? 'other'} />
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-full bg-card/95 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm ring-1 ring-foreground/5 backdrop-blur"
      aria-label={`Listed on ${sources.map((s) => SOURCE_LABELS[s]).join(', ')}`}
    >
      {sources.map((s, i) => (
        <span key={s} className="inline-flex items-center gap-1.5" aria-hidden="true">
          {i > 0 && <span className="text-muted-foreground">·</span>}
          <SourceDot source={s} />
          {SOURCE_LABELS[s]}
        </span>
      ))}
    </span>
  )
}

export function SourceBadge({ source }: { source: Source }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-card/95 px-2.5 py-1 text-xs font-medium text-foreground shadow-sm ring-1 ring-foreground/5 backdrop-blur">
      <SourceDot source={source} />
      {SOURCE_LABELS[source]}
    </span>
  )
}
