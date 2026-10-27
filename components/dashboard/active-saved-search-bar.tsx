'use client'

import { Bookmark, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Listing } from '@/lib/listings'
import { LISTING_STATE_LABELS, STORED_LISTING_STATES } from '@/lib/saved-searches'
import type { ActiveSavedSearch } from './use-saved-searches'

export function ActiveSavedSearchBar({
  active,
  results,
  onClose,
}: {
  active: ActiveSavedSearch
  results: Listing[]
  onClose: () => void
}) {
  const counts = STORED_LISTING_STATES.map((state) => ({
    state,
    count: results.filter((card) => active.stateOf(card) === state).length,
  })).filter((c) => c.count > 0)

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border bg-accent/60 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <Bookmark className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate font-medium">{active.search.name}</span>
        {active.search.clientName && <span className="text-muted-foreground">{`for ${active.search.clientName}`}</span>}
        {counts.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {counts.map((c) => `${c.count} ${LISTING_STATE_LABELS[c.state].toLowerCase()}`).join(' · ')}
          </span>
        )}
      </div>
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close saved search">
        <X className="size-4" aria-hidden="true" />
      </Button>
    </div>
  )
}
