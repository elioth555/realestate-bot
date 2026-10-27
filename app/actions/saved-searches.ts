'use server'

import { getAdminClient } from '@/lib/upsert-property'
import {
  SAVED_SEARCH_COLUMNS,
  clientFieldsPatch,
  isListingId,
  isSavedSearchId,
  isStoredListingState,
  rowToSavedSearch,
  sanitizeFilters,
  sanitizeSort,
  type ClientFields,
  type ListingState,
  type ListingStateEntry,
  type SavedSearch,
  type SavedSearchRow,
} from '@/lib/saved-searches'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; setupRequired?: boolean }

const SETUP_MESSAGE = 'Saved searches need their Supabase tables. Run scripts/sql/saved-searches.sql in the Supabase SQL editor.'

function client() {
  return getAdminClient()
}

function failure(error: { message: string; code?: string } | null, fallback: string): { ok: false; message: string; setupRequired?: boolean } {
  // 42P01/PGRST205: table missing; 42501: grants missing.
  if (error && ['42P01', 'PGRST205', '42501'].includes(error.code ?? '')) {
    return { ok: false, message: SETUP_MESSAGE, setupRequired: true }
  }
  if (error) console.error(`[saved-searches] ${fallback}:`, error.code, error.message)
  return { ok: false, message: fallback }
}

const NOT_CONFIGURED = { ok: false as const, message: 'Saved searches need SUPABASE_SECRET_KEY on the server.' }

export async function listSavedSearches(): Promise<ActionResult<SavedSearch[]>> {
  const supabase = client()
  if (!supabase) return NOT_CONFIGURED
  const { data, error } = await supabase
    .from('saved_searches')
    .select(SAVED_SEARCH_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) return failure(error, 'Could not load saved searches.')
  return {
    ok: true,
    data: ((data ?? []) as SavedSearchRow[]).map(rowToSavedSearch).filter((s): s is SavedSearch => s !== null),
  }
}

export async function createSavedSearch(input: {
  name: string
  scope: string
  filters: unknown
  sort: string
}): Promise<ActionResult<SavedSearch>> {
  const supabase = client()
  if (!supabase) return NOT_CONFIGURED
  if (input.scope !== 'rent' && input.scope !== 'sale') return { ok: false, message: 'Choose Rent or Sale.' }
  const checked = clientFieldsPatch({ name: input.name })
  if (!checked.ok) return checked
  const { data, error } = await supabase
    .from('saved_searches')
    .insert({
      name: checked.patch.name,
      transaction_type: input.scope,
      filters: sanitizeFilters(input.filters),
      sort: sanitizeSort(input.sort),
    })
    .select(SAVED_SEARCH_COLUMNS)
    .single()
  const saved = data ? rowToSavedSearch(data as SavedSearchRow) : null
  if (error || !saved) return failure(error, 'Could not save the search.')
  return { ok: true, data: saved }
}

export async function updateSavedSearch(id: string, fields: ClientFields): Promise<ActionResult<SavedSearch>> {
  const supabase = client()
  if (!supabase) return NOT_CONFIGURED
  if (!isSavedSearchId(id)) return { ok: false, message: 'Unknown saved search.' }
  const checked = clientFieldsPatch(fields)
  if (!checked.ok) return checked
  return patchSavedSearch(id, { ...checked.patch, updated_at: new Date().toISOString() }, 'Could not update the search.')
}

/** Opening a search resets its new-match count: later imports are counted from this moment. */
export async function markSavedSearchChecked(id: string): Promise<ActionResult<SavedSearch>> {
  const supabase = client()
  if (!supabase) return NOT_CONFIGURED
  if (!isSavedSearchId(id)) return { ok: false, message: 'Unknown saved search.' }
  return patchSavedSearch(id, { last_checked_at: new Date().toISOString() }, 'Could not mark the search as checked.')
}

async function patchSavedSearch(id: string, patch: Record<string, unknown>, fallback: string): Promise<ActionResult<SavedSearch>> {
  const supabase = client()
  if (!supabase) return NOT_CONFIGURED
  const { data, error } = await supabase.from('saved_searches').update(patch).eq('id', id).select(SAVED_SEARCH_COLUMNS).maybeSingle()
  if (error) return failure(error, fallback)
  const saved = data ? rowToSavedSearch(data as SavedSearchRow) : null
  if (!saved) return { ok: false, message: 'That saved search no longer exists.' }
  return { ok: true, data: saved }
}

export async function deleteSavedSearch(id: string): Promise<ActionResult<null>> {
  const supabase = client()
  if (!supabase) return NOT_CONFIGURED
  if (!isSavedSearchId(id)) return { ok: false, message: 'Unknown saved search.' }
  const { error } = await supabase.from('saved_searches').delete().eq('id', id)
  if (error) return failure(error, 'Could not delete the search.')
  return { ok: true, data: null }
}

export async function listListingStates(searchId: string): Promise<ActionResult<ListingStateEntry[]>> {
  const supabase = client()
  if (!supabase) return NOT_CONFIGURED
  if (!isSavedSearchId(searchId)) return { ok: false, message: 'Unknown saved search.' }
  const { data, error } = await supabase
    .from('saved_search_listing_states')
    .select('listing_id,state,updated_at')
    .eq('saved_search_id', searchId)
    .limit(5000)
  if (error) return failure(error, 'Could not load listing states.')
  return {
    ok: true,
    data: ((data ?? []) as { listing_id: string; state: string; updated_at: string }[])
      .filter((r) => isStoredListingState(r.state))
      .map((r) => ({ listingId: r.listing_id, state: r.state as ListingStateEntry['state'], updatedAt: r.updated_at })),
  }
}

/**
 * Sets one card's state for a saved search. The state is written against the card's representative id;
 * every member id is cleared first so an older state on another member cannot win.
 */
export async function setListingState(
  searchId: string,
  listingId: string,
  memberIds: string[],
  state: ListingState,
): Promise<ActionResult<null>> {
  const supabase = client()
  if (!supabase) return NOT_CONFIGURED
  if (!isSavedSearchId(searchId) || !isListingId(listingId)) return { ok: false, message: 'Unknown listing.' }
  if (state !== 'unseen' && !isStoredListingState(state)) return { ok: false, message: 'Unknown state.' }
  const ids = [...new Set([listingId, ...memberIds.filter(isListingId)])].slice(0, 50)

  const cleared = await supabase.from('saved_search_listing_states').delete().eq('saved_search_id', searchId).in('listing_id', ids)
  if (cleared.error) return failure(cleared.error, 'Could not update the listing state.')
  if (state === 'unseen') return { ok: true, data: null }

  const { error } = await supabase
    .from('saved_search_listing_states')
    .insert({ saved_search_id: searchId, listing_id: listingId, state, updated_at: new Date().toISOString() })
  if (error) return failure(error, 'Could not update the listing state.')
  return { ok: true, data: null }
}
