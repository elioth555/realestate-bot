import type { NextRequest } from 'next/server'
import { isAuthorizedCronRequest } from '@/lib/cron-auth'
import { getAdminClient } from '@/lib/upsert-property'
import { fetchAllPages } from '@/lib/paginate'
import { SAVED_SEARCH_COLUMNS, rowToSavedSearch, type SavedSearch, type SavedSearchRow } from '@/lib/saved-searches'
import { startYad2RunsForUrls } from '@/lib/yad2-search'
import { startMadlanActorInputs } from '@/lib/madlan-search'
import { startFacebookRun } from '@/lib/facebook-search'
import { FACEBOOK_GROUP_URLS } from '@/lib/facebook-groups'
import { israelHour } from '@/lib/saved-search-alerts'
import {
  SCHEDULED_REFRESH_HOUR,
  isScheduledRefreshWindow,
  israelDateKey,
  planScheduledRefresh,
  runScheduledRefresh,
  stableKey,
  type SourceStartResult,
} from '@/lib/scheduled-refresh'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE = { pageSize: 1000, maxPages: 100 }
const CLAIMS = 'scheduled_source_refreshes'

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/**
 * Daily source refresh. Vercel Cron calls this at 03:30 and 04:30 UTC; only the call in the 06:xx hour in Israel
 * (DST-aware) acts. It only starts Apify runs — the existing webhooks import the results.
 * `?dryRun=1` returns the deduplicated plan with no Apify calls and no database writes.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return json(401, { ok: false, error: 'Unauthorized' })
  }

  const dryRun = request.nextUrl.searchParams.get('dryRun') === '1'
  const now = new Date()
  if (!dryRun && !isScheduledRefreshWindow(now)) {
    return json(200, { ok: true, skipped: 'outside-window', israelHour: israelHour(now), targetHour: SCHEDULED_REFRESH_HOUR })
  }

  const supabase = getAdminClient()
  if (!supabase) return json(500, { ok: false, error: 'SUPABASE_SECRET_KEY is not configured.' })

  const searchesRes = await fetchAllPages<SavedSearchRow>(
    (from, to) => supabase.from('saved_searches').select(SAVED_SEARCH_COLUMNS).order('id').range(from, to) as never,
    PAGE,
  )
  if (searchesRes.error) {
    console.error('[source-refresh:cron] could not load saved searches:', searchesRes.error.message)
    return json(500, { ok: false, error: 'Could not load saved searches.' })
  }

  const searches = searchesRes.rows.map(rowToSavedSearch).filter((s): s is SavedSearch => s !== null)
  const plan = planScheduledRefresh(searches)
  const refreshDate = israelDateKey(now)

  const results = await runScheduledRefresh({
    plan,
    dryRun,
    claim: async (source, plannedRuns) => {
      const { error } = await supabase.from(CLAIMS).insert({ refresh_date: refreshDate, source, planned_runs: plannedRuns })
      if (!error) return { status: 'claimed' }
      if (error.code === '23505') return { status: 'already-claimed' }
      return { status: 'error', message: `${error.code ?? ''} ${error.message}`.trim() }
    },
    record: async (source, r) => {
      const { error } = await supabase
        .from(CLAIMS)
        .update({ status: r.status, started_runs: r.startedRuns, run_ids: r.runIds, error: r.error, finished_at: new Date().toISOString() })
        .eq('refresh_date', refreshDate)
        .eq('source', source)
      if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim())
    },
    start: {
      yad2: async (p): Promise<SourceStartResult> => {
        const r = await startYad2RunsForUrls(p.yad2.map((run) => run.input))
        if (!r.ok) return r
        return { ok: true, runIds: r.runs.map((x) => x.runId), failures: r.failedRuns.map((f) => ({ key: f.searchUrl, error: f.error, limitReached: f.limitReached })) }
      },
      madlan: async (p): Promise<SourceStartResult> => {
        const r = await startMadlanActorInputs(p.madlan.map((run) => run.input))
        if (!r.ok) return r
        return {
          ok: true,
          runIds: r.runs.map((x) => x.runId),
          failures: r.failedRuns.map((f) => ({ key: stableKey(f.actorInput), error: f.error, limitReached: f.limitReached })),
        }
      },
      facebook: async (): Promise<SourceStartResult> => {
        const r = await startFacebookRun(FACEBOOK_GROUP_URLS)
        if (!r.ok) return { ok: true, runIds: [], failures: [{ key: 'facebook-groups', error: r.error, limitReached: r.kind === 'limit' }] }
        return { ok: true, runIds: [r.runId], failures: [] }
      },
    },
  })

  let existingClaims: unknown = undefined
  if (dryRun) {
    const { data, error } = await supabase.from(CLAIMS).select('source,status,started_runs,claimed_at').eq('refresh_date', refreshDate)
    existingClaims = error ? { error: `${error.code ?? ''} ${error.message}`.trim() } : data
  }

  for (const r of results) {
    const line = `[source-refresh:cron] ${r.source}: ${r.status} (${r.startedRuns}/${r.plannedRuns} runs)`
    if (r.status === 'failed' || r.status === 'partial' || r.status === 'claim-failed' || r.recordError) {
      console.error(line, r.errors.join(' | '), r.recordError ?? '')
    } else console.log(line)
  }

  const failed = results.some((r) => r.status === 'failed' || r.status === 'partial' || r.status === 'claim-failed' || r.recordError)
  return json(failed ? 207 : 200, {
    ok: !failed,
    dryRun,
    refreshDate,
    savedSearches: searches.length,
    results,
    skipped: plan.skipped,
    notes: plan.notes,
    capped: plan.capped,
    ...(dryRun ? { existingClaims } : {}),
  })
}
