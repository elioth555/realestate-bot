'use client'

import { createContext, useContext } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  createSavedSearch,
  deleteSavedSearch,
  listListingStates,
  listSavedSearches,
  markSavedSearchChecked,
  setListingState,
  updateSavedSearch,
  type ActionResult,
} from '@/app/actions/saved-searches'
import type { Filters, SortKey } from '@/lib/filters'
import type { DealType, Listing } from '@/lib/listings'
import {
  cardListingState,
  cardMemberIds,
  type ClientFields,
  type ListingState,
  type ListingStateEntry,
  type SavedSearch,
} from '@/lib/saved-searches'

const NO_SEARCHES: SavedSearch[] = []
const NO_STATES: ListingStateEntry[] = []

function reportFailure<T>(result: ActionResult<T>): result is Extract<ActionResult<T>, { ok: false }> {
  if (result.ok) return false
  toast.error(result.message)
  return true
}

export function useSavedSearches() {
  const { data, isLoading, mutate } = useSWR('saved-searches', () => listSavedSearches(), { revalidateOnFocus: false })
  const searches = data?.ok ? data.data : NO_SEARCHES

  const replace = (saved: SavedSearch) =>
    mutate((prev) => (prev?.ok ? { ok: true, data: prev.data.map((s) => (s.id === saved.id ? saved : s)) } : prev), {
      revalidate: false,
    })

  return {
    searches,
    isLoading,
    loadError: data && !data.ok ? data : null,
    retry: () => mutate(),
    async create(input: { name: string; scope: DealType; filters: Filters; sort: SortKey }) {
      const result = await createSavedSearch(input)
      if (reportFailure(result)) return null
      await mutate((prev) => (prev?.ok ? { ok: true, data: [result.data, ...prev.data] } : prev), { revalidate: false })
      return result.data
    },
    async update(id: string, fields: ClientFields) {
      const result = await updateSavedSearch(id, fields)
      if (reportFailure(result)) return false
      await replace(result.data)
      return true
    },
    async markChecked(id: string) {
      const result = await markSavedSearchChecked(id)
      if (!reportFailure(result)) await replace(result.data)
    },
    async remove(id: string) {
      const result = await deleteSavedSearch(id)
      if (reportFailure(result)) return false
      await mutate((prev) => (prev?.ok ? { ok: true, data: prev.data.filter((s) => s.id !== id) } : prev), {
        revalidate: false,
      })
      return true
    },
  }
}

export function useListingStates(searchId: string | null) {
  const { data, mutate } = useSWR(searchId ? ['saved-search-states', searchId] : null, () =>
    listListingStates(searchId as string),
  )
  const states = data?.ok ? data.data : NO_STATES

  const setState = async (card: Listing, state: ListingState) => {
    if (!searchId) return
    const members = new Set(cardMemberIds(card))
    const optimistic: ListingStateEntry[] = [
      ...states.filter((s) => !members.has(s.listingId)),
      ...(state === 'unseen' ? [] : [{ listingId: card.id, state, updatedAt: new Date().toISOString() }]),
    ]
    await mutate(
      async () => {
        const result = await setListingState(searchId, card.id, [...members], state)
        if (reportFailure(result)) throw new Error(result.message)
        return { ok: true as const, data: optimistic }
      },
      { optimisticData: { ok: true, data: optimistic }, rollbackOnError: true, revalidate: false },
    ).catch(() => {})
  }

  return { states, stateOf: (card: Listing) => cardListingState(card, states), setState }
}

export type ActiveSavedSearch = {
  search: SavedSearch
  stateOf: (card: Listing) => ListingState
  setState: (card: Listing, state: ListingState) => void
}

export const ActiveSavedSearchContext = createContext<ActiveSavedSearch | null>(null)

export const useActiveSavedSearch = () => useContext(ActiveSavedSearchContext)
