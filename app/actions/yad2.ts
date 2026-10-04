'use server'

import { getYad2RunStatus, startYad2Run, validateCriteria } from '@/lib/yad2-search'

export type Yad2SearchInput = {
  city: string | null
  transactionType: 'rent' | 'sale'
  minRooms: string | null
  maxRooms: string | null
  minPrice: string
  maxPrice: string
  neighborhood: string | null
}

export type StartYad2SearchResult =
  | { ok: true; runId: string; runIds: string[]; status: string; reusedActiveRun: boolean }
  | { ok: false; kind: 'unsupported' | 'invalid' | 'error'; message: string }

export type Yad2RunStatus =
  | { ok: true; status: string; finishedAt: string | null }
  | { ok: false; message: string }

const TEL_AVIV_ALIASES = new Set(['tel aviv', 'tel aviv yafo', 'tel aviv jaffa', 'תל אביב', 'תל אביב יפו'])

function normalizeCity(city: string | null) {
  if (!city) return null
  const key = city.trim().toLowerCase().replace(/[-_\s]+/g, ' ')
  return TEL_AVIV_ALIASES.has(key) ? 'Tel Aviv' : city
}

export async function startYad2Search(input: Yad2SearchInput): Promise<StartYad2SearchResult> {
  const city = normalizeCity(input?.city ?? null)
  if (city !== 'Tel Aviv') {
    return {
      ok: false,
      kind: 'unsupported',
      message: city
        ? `Live Yad2 search supports Tel Aviv only. Showing imported listings for ${city}.`
        : 'Choose Tel Aviv as the city to launch a live Yad2 search.',
    }
  }
  if (input.transactionType !== 'rent') {
    return { ok: false, kind: 'unsupported', message: 'Live Yad2 search supports rentals only.' }
  }

  // min_price is filtered locally after import. Neighborhoods are sent to Yad2 only when they have a confirmed ID;
  // otherwise the search stays Tel Aviv-wide and the local filter still narrows the results.
  const validation = validateCriteria({
    city,
    transaction_type: 'rent',
    min_rooms: input.minRooms,
    max_rooms: input.maxRooms,
    max_price: input.maxPrice,
    neighborhoods: input.neighborhood ? [input.neighborhood] : [],
  })
  if (!validation.ok) return { ok: false, kind: 'invalid', message: validation.errors.join(' ') }

  const run = await startYad2Run(validation.data, { reuseActiveRun: true })
  if (!run.ok) {
    return { ok: false, kind: 'error', message: [run.error, ...(run.details ?? [])].join(' ') }
  }
  return {
    ok: true,
    runId: run.runId,
    runIds: run.runs.map((r) => r.runId),
    status: run.status,
    reusedActiveRun: run.reusedActiveRun,
  }
}

export async function checkYad2Run(runId: string): Promise<Yad2RunStatus> {
  const result = await getYad2RunStatus(runId)
  return result.ok ? { ok: true, status: result.status, finishedAt: result.finishedAt } : { ok: false, message: result.error }
}
