'use server'

import { getMadlanRunStatus, startMadlanRuns, validateMadlanCriteria } from '@/lib/madlan-search'

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
  | { ok: true; runIds: string[]; status: string; startFailures: number; startLimitReached: boolean }
  | { ok: false; kind: 'unsupported' | 'invalid' | 'limit' | 'error'; message: string }

export type MadlanRunStatus =
  | { ok: true; status: string; finishedAt: string | null }
  | { ok: false; message: string }

const TEL_AVIV_ALIASES = new Set(['tel aviv', 'tel aviv yafo', 'tel aviv jaffa', 'tlv', 'תל אביב', 'תל אביב יפו'])

export async function startMadlanSearch(input: MadlanSearchInput): Promise<StartMadlanSearchResult> {
  const cityKey = (input?.city ?? '').trim().toLowerCase().replace(/[-_\s]+/g, ' ')
  if (!TEL_AVIV_ALIASES.has(cityKey)) {
    return {
      ok: false,
      kind: 'unsupported',
      message: input?.city
        ? `Live Madlan refresh supports Tel Aviv only. Showing imported listings for ${input.city}.`
        : 'Choose Tel Aviv as the city to refresh Madlan.',
    }
  }
  if (input.transactionType !== 'rent' && input.transactionType !== 'sale') {
    return { ok: false, kind: 'invalid', message: 'Choose Rent or Sale to refresh Madlan.' }
  }

  const validation = validateMadlanCriteria({
    city: input.city,
    transaction_type: input.transactionType,
    min_price: input.minPrice,
    max_price: input.maxPrice,
    min_rooms: input.minRooms,
    max_rooms: input.maxRooms,
    parking: input.parking,
    elevator: input.elevator,
    balcony: input.balcony,
    mamad: input.mamad,
    neighborhoods: input.neighborhoods,
  })
  if (!validation.ok) return { ok: false, kind: 'invalid', message: validation.errors.join(' ') }

  const result = await startMadlanRuns(validation.data)
  if (!result.ok) {
    return {
      ok: false,
      kind: result.limitReached ? 'limit' : 'error',
      message: result.limitReached
        ? 'Apify concurrency limit reached: another run is still active, so this Madlan refresh could not start. Try again once it finishes.'
        : [result.error, ...(result.details ?? [])].join(' '),
    }
  }
  return {
    ok: true,
    runIds: result.runs.map((r) => r.runId),
    status: result.runs[0]?.status ?? 'READY',
    startFailures: result.failedRuns.length,
    startLimitReached: result.failedRuns.some((f) => f.limitReached),
  }
}

export async function checkMadlanRun(runId: string): Promise<MadlanRunStatus> {
  const result = await getMadlanRunStatus(runId)
  return result.ok ? { ok: true, status: result.status, finishedAt: result.finishedAt } : { ok: false, message: result.error }
}
