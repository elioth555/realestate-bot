import type { NextRequest } from 'next/server'
import { isAuthorizedCronRequest } from '@/lib/cron-auth'
import { getAdminClient } from '@/lib/upsert-property'
import { fetchListings } from '@/lib/supabase'
import { fetchAllPages } from '@/lib/paginate'
import { sendWithResend } from '@/lib/alert-email-sender'
import { SAVED_SEARCH_COLUMNS, rowToSavedSearch, type SavedSearch, type SavedSearchRow } from '@/lib/saved-searches'
import { ALERT_CHANNEL, DAILY_ALERT_HOUR, DAILY_ALERT_TIMEZONE, isDailyAlertWindow, israelHour, runDailyAlerts, type AlertRow } from '@/lib/saved-search-alerts'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE = { pageSize: 1000, maxPages: 100 }

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/**
 * Daily saved-search email alerts. Vercel Cron calls this at 05:00 and 06:00 UTC; only the call that lands in
 * the 08:00 hour in Israel (DST-aware) sends. `?dryRun=1` computes what would be sent with no sends and no writes.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return json(401, { ok: false, error: 'Unauthorized' })
  }

  const dryRun = request.nextUrl.searchParams.get('dryRun') === '1'
  const now = new Date()
  if (!dryRun && !isDailyAlertWindow(now)) {
    return json(200, { ok: true, skipped: 'outside-window', israelHour: israelHour(now), targetHour: DAILY_ALERT_HOUR, timezone: DAILY_ALERT_TIMEZONE })
  }

  const supabase = getAdminClient()
  if (!supabase) return json(500, { ok: false, error: 'SUPABASE_SECRET_KEY is not configured.' })

  const [searchesRes, alertsRes] = await Promise.all([
    fetchAllPages<SavedSearchRow>((from, to) => supabase.from('saved_searches').select(SAVED_SEARCH_COLUMNS).order('id').range(from, to) as never, PAGE),
    fetchAllPages<{ saved_search_id: string; listing_id: string }>(
      (from, to) =>
        supabase
          .from('saved_search_alerts')
          .select('saved_search_id,listing_id')
          .eq('channel', ALERT_CHANNEL)
          .order('saved_search_id')
          .order('listing_id')
          .range(from, to),
      PAGE,
    ),
  ])
  if (searchesRes.error || alertsRes.error) {
    console.error('[saved-search-alerts:cron] load failed:', searchesRes.error?.message ?? alertsRes.error?.message)
    return json(500, { ok: false, error: 'Could not load saved searches or sent alerts.' })
  }

  let cards: Awaited<ReturnType<typeof fetchListings>>
  try {
    cards = await fetchListings()
  } catch (error) {
    console.error('[saved-search-alerts:cron] could not load listings:', error instanceof Error ? error.message : error)
    return json(500, { ok: false, error: 'Could not load listings.' })
  }

  const searches = searchesRes.rows.map(rowToSavedSearch).filter((s): s is SavedSearch => s !== null)
  const alertedIdsBySearch = new Map<string, Set<string>>()
  for (const row of alertsRes.rows) {
    let ids = alertedIdsBySearch.get(row.saved_search_id)
    if (!ids) alertedIdsBySearch.set(row.saved_search_id, (ids = new Set()))
    ids.add(row.listing_id)
  }

  const results = await runDailyAlerts({
    searches,
    cards,
    alertedIdsBySearch,
    dryRun,
    send: sendWithResend,
    record: async (rows: AlertRow[]) => {
      const { error } = await supabase.from('saved_search_alerts').upsert(rows, { onConflict: 'saved_search_id,listing_id,channel', ignoreDuplicates: true })
      return error ? { ok: false as const, message: `${error.code ?? ''} ${error.message}`.trim() } : { ok: true as const }
    },
  })

  const counts: Record<string, number> = {}
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1
  for (const r of results) {
    if (r.status === 'sent-not-recorded') console.error(`[saved-search-alerts:cron] EMAIL SENT BUT NOT RECORDED for saved search ${r.searchId}: ${r.message}`)
    else if (r.status === 'send-failed' || r.status === 'error') console.error(`[saved-search-alerts:cron] ${r.status} for saved search ${r.searchId}: ${r.message}`)
  }
  console.log(`[saved-search-alerts:cron] ${dryRun ? 'dry run' : 'run'} complete:`, JSON.stringify(counts))

  const failed = (counts['sent-not-recorded'] ?? 0) + (counts['send-failed'] ?? 0) + (counts.error ?? 0)
  return json(failed > 0 ? 207 : 200, { ok: failed === 0, dryRun, searches: searches.length, counts, results })
}
