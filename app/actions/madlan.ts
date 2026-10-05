'use server'

import { startMadlanRuns, validateMadlanCriteria } from '@/lib/madlan-search'

export type MadlanSearchInput = {
  city: string | null
  transactionType: 'rent' | 'sale'
  minPrice?: string | number | null
  maxPrice?: string | number | null
  minRooms?: string | number | null
  maxRooms?: string | number | null
  parking?: boolean
  elevator?: boolean
  balcony?: boolean
  mamad?: boolean
  neighborhoods?: string[]
}

export type StartMadlanSearchResult =
  | { ok: true; runIds: string[]; startFailures: number; startLimitReached: boolean }
  | { ok: false; kind: 'invalid' | 'limit' | 'error'; message: string }

/** Not wired to the dashboard yet; the backend pipeline is tested on its own first. */
export async function startMadlanSearch(input: MadlanSearchInput): Promise<StartMadlanSearchResult> {
  const validation = validateMadlanCriteria({
    city: input?.city,
    transaction_type: input?.transactionType,
    min_price: input?.minPrice,
    max_price: input?.maxPrice,
    min_rooms: input?.minRooms,
    max_rooms: input?.maxRooms,
    parking: input?.parking,
    elevator: input?.elevator,
    balcony: input?.balcony,
    mamad: input?.mamad,
    neighborhoods: input?.neighborhoods,
  })
  if (!validation.ok) return { ok: false, kind: 'invalid', message: validation.errors.join(' ') }

  const result = await startMadlanRuns(validation.data)
  if (!result.ok) {
    return {
      ok: false,
      kind: result.limitReached ? 'limit' : 'error',
      message: [result.error, ...(result.details ?? [])].join(' '),
    }
  }
  return {
    ok: true,
    runIds: result.runs.map((r) => r.runId),
    startFailures: result.failedRuns.length,
    startLimitReached: result.failedRuns.some((f) => f.limitReached),
  }
}
