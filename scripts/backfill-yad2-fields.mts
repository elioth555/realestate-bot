/**
 * One-time backfill of fields the improved Yad2 mapper now extracts, using ONLY datasets
 * of past Apify runs. It never starts an actor run.
 *
 * Safety:
 * - Dry run by default; pass --apply to write.
 * - Only fills columns that are currently NULL; never overwrites an existing value, never writes null.
 * - Matches rows by source_url, the same key the importer uses.
 *
 * Run (dry run):
 *   node --env-file-if-exists=/vercel/share/.env.project --experimental-strip-types scripts/backfill-yad2-fields.mts
 */
import { mapYad2Item, type Yad2Item } from '../lib/yad2-mapper.ts'
import { getAdminClient } from '../lib/upsert-property.ts'

const BACKFILL_COLUMNS = ['description', 'balcony', 'furnished', 'available_from'] as const
const APPLY = process.argv.includes('--apply')
const APIFY = 'https://api.apify.com/v2'

const token = process.env.APIFY_API_TOKEN
const actorId = process.env.APIFY_YAD2_ACTOR_ID
if (!token || !actorId) throw new Error('APIFY_API_TOKEN and APIFY_YAD2_ACTOR_ID are required')

async function apifyGet<T>(path: string): Promise<T> {
  const res = await fetch(`${APIFY}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Apify GET ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

type Run = { id: string; status: string; defaultDatasetId: string; startedAt: string }

const runs: Run[] = []
for (let offset = 0; ; offset += 100) {
  const page = await apifyGet<{ data: { items: Run[] } }>(
    `/acts/${encodeURIComponent(actorId.replace('/', '~'))}/runs?limit=100&offset=${offset}&desc=1`,
  )
  runs.push(...page.data.items)
  if (page.data.items.length < 100) break
}

// Newest run wins per listing, so later scrapes take precedence over older ones.
const bestByUrl = new Map<string, Partial<Record<(typeof BACKFILL_COLUMNS)[number], unknown>>>()
for (const run of runs.filter((r) => r.status === 'SUCCEEDED')) {
  let items: Yad2Item[]
  try {
    items = await apifyGet<Yad2Item[]>(`/datasets/${run.defaultDatasetId}/items?clean=1&format=json`)
  } catch (error) {
    console.warn(`skip run ${run.id}: ${(error as Error).message}`)
    continue
  }
  for (const item of items) {
    const mapped = mapYad2Item(item) as Record<string, unknown>
    const url = mapped.source_url as string | undefined
    if (!url || bestByUrl.has(url)) continue
    bestByUrl.set(url, Object.fromEntries(BACKFILL_COLUMNS.map((c) => [c, mapped[c]])))
  }
}

const sb = getAdminClient()
const { data: rows, error } = await sb
  .from('properties')
  .select(['id', 'source_url', ...BACKFILL_COLUMNS].join(','))
  .eq('source', 'yad2')
if (error) throw error

const filled: Record<string, number> = Object.fromEntries(BACKFILL_COLUMNS.map((c) => [c, 0]))
let rowsToUpdate = 0
for (const row of (rows ?? []) as unknown as Record<string, unknown>[]) {
  const source = bestByUrl.get(row.source_url as string)
  if (!source) continue
  const patch: Record<string, unknown> = {}
  for (const column of BACKFILL_COLUMNS) {
    const next = source[column]
    const isEmpty = row[column] === null || (typeof row[column] === 'string' && !(row[column] as string).trim())
    if (isEmpty && next !== null && next !== undefined && next !== '') {
      patch[column] = next
      filled[column]++
    }
  }
  if (!Object.keys(patch).length) continue
  rowsToUpdate++
  if (APPLY) {
    const { error: updateError } = await sb.from('properties').update(patch).eq('id', row.id as number)
    if (updateError) console.error(`row ${row.id}: ${updateError.message}`)
  }
}

console.log({
  mode: APPLY ? 'apply' : 'dry-run',
  runsScanned: runs.length,
  listingsInDatasets: bestByUrl.size,
  rowsToUpdate,
  columnsFilled: filled,
})
