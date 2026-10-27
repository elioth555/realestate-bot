'use client'

import { cn } from '@/lib/utils'
import type { Listing } from '@/lib/listings'
import { LISTING_STATE_LABELS, type ListingState } from '@/lib/saved-searches'
import { useActiveSavedSearch } from './use-saved-searches'

const STATES: ListingState[] = ['unseen', 'viewed', 'sent', 'rejected']

/** Shown only while a saved search is open: this listing's status for that client. */
export function ClientListingState({ listing }: { listing: Listing }) {
  const active = useActiveSavedSearch()
  if (!active) return null
  const current = active.stateOf(listing)

  return (
    <fieldset className="rounded-lg border bg-muted/40 p-3">
      <legend className="sr-only">{`Status for ${active.search.name}`}</legend>
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {`For ${active.search.clientName || active.search.name}`}
      </p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {STATES.map((state) => (
          <button
            key={state}
            type="button"
            aria-pressed={current === state}
            onClick={() => active.setState(listing, state)}
            className={cn(
              'h-8 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              current === state ? 'border-primary/40 bg-accent text-accent-foreground' : 'bg-background hover:bg-muted',
            )}
          >
            {LISTING_STATE_LABELS[state]}
          </button>
        ))}
      </div>
    </fieldset>
  )
}
