// Read-only: counts derived freshness statuses per source and after the real dashboard merge.
import { createClient } from '@supabase/supabase-js'
import { fetchListings, rowToListing } from '../../lib/supabase.ts'
import { fetchAllPages } from '../../lib/paginate.ts'
import { COVERAGE_RUN_COLUMNS, withFreshness } from '../../lib/listing-freshness.ts'
import { dedupeFacebookListings } from '../../lib/facebook-dedupe.ts'
import { dedupeAcrossSources } from '../../lib/cross-source-dedupe.ts'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!)

const rows = await fetchAllPages<any>(
  (from, to) => sb.from('properties').select('*').order('id', { ascending: true }).range(from, to) as any,
  { pageSize: 1000, maxPages: 50, keyOf: (r: any) => String(r.id) },
)
const allRuns = await sb.from('source_refresh_runs').select(COVERAGE_RUN_COLUMNS + ',truncated').order('id')
if (rows.error || allRuns.error) throw new Error(rows.error?.message ?? allRuns.error?.message)
const runs = (allRuns.data as any[]).filter((r) => r.status === 'succeeded' && !r.truncated)

const now = new Date()
const source = rows.rows.map((row) => withFreshness(rowToListing(row), row, runs as any, now))

const tally = (list: { freshness?: string; source: string }[]) => {
  const out: Record<string, Record<string, number>> = {}
  for (const l of list) {
    const s = l.freshness ?? 'none'
    out.all ??= {}
    out.all[s] = (out.all[s] ?? 0) + 1
    out[l.source] ??= {}
    out[l.source][s] = (out[l.source][s] ?? 0) + 1
  }
  return out
}

const cards = await fetchListings()
const plainCards = dedupeAcrossSources(dedupeFacebookListings(rows.rows.map((r) => rowToListing(r))))

console.log(JSON.stringify({
  propertyRows: rows.rows.length,
  runsTotal: (allRuns.data as any[]).length,
  runsCounting: runs.map((r) => ({ id: r.id, source: r.source, type: r.transaction_type, scope: r.neighborhoods ?? r.scope_kind, finished: r.finished_at })),
  runsNotCounting: (allRuns.data as any[]).filter((r) => !(r.status === 'succeeded' && !r.truncated)).map((r) => ({ id: r.id, source: r.source, status: r.status, truncated: r.truncated })),
  sourceRecordCounts: tally(source),
  mergedCardCounts: tally(cards),
  mergedCards: cards.length,
  cardsWithoutFreshnessCode: plainCards.length,
  cardsWithNoStatus: cards.filter((c) => !c.freshness).length,
  mergedCardsWithMixedStatus: cards.filter((c) => (c.listedAt?.length ?? 0) > 1).length,
}, null, 2))
