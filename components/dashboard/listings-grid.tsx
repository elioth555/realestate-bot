'use client'

import { useState } from 'react'
import { SearchX } from 'lucide-react'
import type { Listing } from '@/lib/listings'
import { ListingCard } from './listing-card'
import { ListingDetailSheet } from './listing-detail-sheet'
import { useActiveSavedSearch } from './use-saved-searches'

type ListingsGridProps = {
  listings: Listing[]
  favorites: Set<string>
  onToggleFavorite: (id: string) => void
  emptyTitle: string
  emptyDescription: string
}

export function ListingsGrid({ listings, favorites, onToggleFavorite, emptyTitle, emptyDescription }: ListingsGridProps) {
  const [selected, setSelected] = useState<Listing | null>(null)
  const activeSearch = useActiveSavedSearch()

  const open = (listing: Listing) => {
    setSelected(listing)
    if (activeSearch && activeSearch.stateOf(listing) === 'unseen') activeSearch.setState(listing, 'viewed')
  }

  if (listings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 py-16 text-center">
        <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-accent text-primary">
          <SearchX className="size-5" aria-hidden="true" />
        </span>
        <h3 className="text-sm font-semibold">{emptyTitle}</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{emptyDescription}</p>
      </div>
    )
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {listings.map((listing) => (
          <ListingCard
            key={listing.id}
            listing={listing}
            isFavorite={favorites.has(listing.id)}
            onToggleFavorite={onToggleFavorite}
            onOpen={open}
          />
        ))}
      </div>
      <ListingDetailSheet listing={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </>
  )
}
