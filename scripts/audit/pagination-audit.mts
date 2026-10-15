// Read-only: compares the old 1,000-row cap with full pagination and times fetchListings().
import { createClient } from '@supabase/supabase-js'
import { fetchListings, rowToListing } from '../../lib/supabase.ts'
import { dedupeFacebookListings } from '../../lib/facebook-dedupe.ts'
import { dedupeAcrossSources } from '../../lib/cross-source-dedupe.ts'
import { fetchAllPages } from '../../lib/paginate.ts'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!)

const { count } = await sb.from('properties').select('id', { count: 'exact', head: true })

const ordered = (from: number, to: number) =>
  sb
    .from('properties')
    .select('*')
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(from, to) as any

const old = await sb
  .from('properties')
  .select('id')
  .order('published_at', { ascending: false, nullsFirst: false })
  .limit(1000)

const t0 = performance.now()
const all = await fetchAllPages<any>(ordered, { pageSize: 1000, maxPages: 50, keyOf: (r: any) => String(r.id) })
const propertyRowsMs = Math.round(performance.now() - t0)

const oldIds = new Set((old.data ?? []).map((r: any) => String(r.id)))
const oldRows = all.rows.filter((r) => oldIds.has(String(r.id)))
const invisible = all.rows.filter((r) => !oldIds.has(String(r.id)))
const invisibleBySource: Record<string, number> = {}
for (const r of invisible) invisibleBySource[r.source ?? '?'] = (invisibleBySource[r.source ?? '?'] ?? 0) + 1

const pipeline = (rows: any[]) => {
  const fb = dedupeFacebookListings(rows.map((r) => rowToListing(r, [])))
  return { afterFacebookDedupe: fb.length, afterCrossSourceDedupe: dedupeAcrossSources(fb).length }
}

const fetchListingsMs: number[] = []
let cards = 0
for (let i = 0; i < 3; i++) {
  const s = performance.now()
  cards = (await fetchListings()).length
  fetchListingsMs.push(Math.round(performance.now() - s))
}

console.log(
  JSON.stringify(
    {
      dbCount: count,
      rawLoaded: all.rows.length,
      pages: all.pages,
      uniqueIds: new Set(all.rows.map((r) => String(r.id))).size,
      now: pipeline(all.rows),
      before: { rawLoaded: oldRows.length, ...pipeline(oldRows) },
      previouslyInvisible: invisible.length,
      invisibleBySource,
      invisibleNullPublishedAt: invisible.filter((r) => !r.published_at).length,
      fetchListingsCards: cards,
      propertyRowsMs,
      fetchListingsMs,
    },
    null,
    2,
  ),
)
