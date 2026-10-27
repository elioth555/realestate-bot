import { CANONICAL_NEIGHBORHOODS, isCanonicalCity } from './geo/canonical-neighborhoods'
import { NEIGHBORHOOD_ALIASES, aliasKey } from './normalize'
import { canonicalFacebookGroupUrl } from './facebook-search'
import { YAD2_NEIGHBORHOODS } from './yad2-neighborhoods'
import { yad2TransactionTypeFromActorInput } from './yad2-search'

/**
 * Refresh coverage and listing freshness. Pure: no I/O, so every rule is tested offline.
 *
 * A listing only ages against successful, complete refresh runs whose scope could have returned it.
 * Status is derived when read, never stored.
 */

export type RefreshSource = 'yad2' | 'madlan' | 'facebook'
export type RefreshRunStatus = 'succeeded' | 'partial' | 'failed'
export type ScopeKind = 'city' | 'neighborhoods' | 'groups'

/** One row of public.source_refresh_runs (minus the generated id / created_at). */
export type RefreshRunRow = {
  source: RefreshSource
  transaction_type: 'rent' | 'sale' | null
  actor_run_id: string
  started_at: string | null
  finished_at: string
  status: RefreshRunStatus
  scope_kind: ScopeKind
  neighborhoods: string[] | null
  group_urls: string[] | null
  /** Facebook only: group id (as it appears in post URLs, lowercased) → oldest post time returned. */
  group_windows: Record<string, string> | null
  min_rooms: number | null
  max_rooms: number | null
  min_price: number | null
  max_price: number | null
  item_count: number
  items_imported: number
  items_failed: number
  truncated: boolean
}

export type RunScope = Pick<
  RefreshRunRow,
  | 'transaction_type'
  | 'scope_kind'
  | 'neighborhoods'
  | 'group_urls'
  | 'group_windows'
  | 'min_rooms'
  | 'max_rooms'
  | 'min_price'
  | 'max_price'
> & {
  /** Anything that makes the scope unrepresentable; a non-empty list makes the run `partial`. */
  problems: string[]
}

/** One Yad2 results page. maxPagesPerSearch = 1, so a run returning a full page may have more results. */
export const YAD2_PAGE_SIZE = 40

// ---------- run metadata from the webhook payload ----------

export type RunMeta = { runId: string | null; startedAt: string | null; finishedAt: string | null }

function isoOrNull(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

export function extractRunMeta(payload: unknown): RunMeta {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const resource = (body.resource && typeof body.resource === 'object' ? body.resource : {}) as Record<string, unknown>
  const runId = resource.id ?? body.actorRunId ?? (body.eventData as Record<string, unknown> | undefined)?.actorRunId
  return {
    runId: typeof runId === 'string' && runId.trim() ? runId.trim() : null,
    startedAt: isoOrNull(resource.startedAt),
    finishedAt: isoOrNull(resource.finishedAt),
  }
}

// ---------- neighborhoods ----------

const CANONICAL = new Set<string>(CANONICAL_NEIGHBORHOODS)

/**
 * Yad2 ID → canonical neighborhood, only where one ID is the WHOLE neighborhood.
 * Old North is split over two IDs and New North's southern ID is unconfirmed, so a run on one of
 * those IDs covers only part of the neighborhood and must not age listings there.
 */
const PARTIAL_YAD2_NEIGHBORHOODS = new Set(['New North'])
const YAD2_ID_TO_CANONICAL = new Map<string, string>()
for (const [name, entry] of Object.entries(YAD2_NEIGHBORHOODS)) {
  if (entry.yad2Ids.length === 1 && CANONICAL.has(name) && !PARTIAL_YAD2_NEIGHBORHOODS.has(name)) {
    YAD2_ID_TO_CANONICAL.set(entry.yad2Ids[0], name)
  }
}

const ALIAS_TO_CANONICAL = new Map<string, string>()
for (const [canonical, aliases] of Object.entries(NEIGHBORHOOD_ALIASES)) {
  if (!CANONICAL.has(canonical)) continue
  for (const alias of [canonical, ...aliases]) ALIAS_TO_CANONICAL.set(aliasKey(alias), canonical)
}

// ---------- Yad2 scope ----------

const YAD2_ALLOWED_PARAMS = new Set(['topArea', 'area', 'city', 'neighborhood', 'minRooms', 'maxRooms', 'maxPrice'])
const YAD2_TEL_AVIV = { topArea: '2', area: '1', city: '5000' }

function positiveNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

/** Scope of a Yad2 run from its saved INPUT. Null when the deal type itself can't be read (nothing to record). */
export function yad2RunScope(input: unknown): RunScope | null {
  const deal = yad2TransactionTypeFromActorInput(input)
  if (!deal.ok) return null

  const problems: string[] = []
  const startUrls = (input as { start_urls: unknown[] }).start_urls
  const neighborhoods = new Set<string>()
  let cityWide = false
  const filters = new Set<string>()
  let minRooms: number | null = null
  let maxRooms: number | null = null
  let maxPrice: number | null = null

  for (const entry of startUrls) {
    const raw = typeof entry === 'string' ? entry : (entry as { url: string }).url
    const url = new URL(raw)
    for (const key of url.searchParams.keys()) {
      if (!YAD2_ALLOWED_PARAMS.has(key)) problems.push(`Unknown Yad2 filter "${key}".`)
    }
    for (const [key, expected] of Object.entries(YAD2_TEL_AVIV)) {
      if (url.searchParams.get(key) !== expected) problems.push('Start URL is not the Tel Aviv search.')
    }
    const id = url.searchParams.get('neighborhood')
    if (id === null) cityWide = true
    else {
      const canonical = YAD2_ID_TO_CANONICAL.get(id)
      if (canonical) neighborhoods.add(canonical)
      else problems.push(`Yad2 neighborhood ${id} does not map to one whole canonical neighborhood.`)
    }
    minRooms = positiveNumber(url.searchParams.get('minRooms'))
    maxRooms = positiveNumber(url.searchParams.get('maxRooms'))
    maxPrice = positiveNumber(url.searchParams.get('maxPrice'))
    filters.add(JSON.stringify([minRooms, maxRooms, maxPrice]))
  }
  if (filters.size > 1) problems.push('Start URLs use different filters.')
  if (cityWide && neighborhoods.size > 0) problems.push('Run mixes city-wide and neighborhood start URLs.')

  return {
    transaction_type: deal.transactionType,
    scope_kind: cityWide ? 'city' : 'neighborhoods',
    neighborhoods: cityWide ? null : [...neighborhoods].sort(),
    group_urls: null,
    group_windows: null,
    min_rooms: minRooms,
    max_rooms: maxRooms,
    min_price: null,
    max_price: maxPrice,
    problems: [...new Set(problems)],
  }
}

export function yad2RunTruncated(itemCount: number) {
  return itemCount >= YAD2_PAGE_SIZE
}

// ---------- Madlan scope ----------

const MADLAN_ALLOWED_KEYS = new Set([
  'city',
  'dealType',
  'maxItems',
  'minPrice',
  'maxPrice',
  'minRooms',
  'maxRooms',
  'neighbourhood',
])
// Actor/output options: they change what each item contains, not which properties the search returns.
const MADLAN_OUTPUT_OPTIONS = new Set(['excludeAgents', 'enrichInsights', 'includeContactMetadata'])
const MADLAN_NARROWING_FLAGS = ['requireParking', 'requireElevator', 'requireBalcony', 'requireSecureRoom']

/** Scope of a Madlan run from its saved INPUT. Null when the deal type can't be read. */
export function madlanRunScope(input: unknown): (RunScope & { max_items: number | null }) | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const body = input as Record<string, unknown>
  const transactionType = body.dealType === 'rent' ? 'rent' : body.dealType === 'buy' ? 'sale' : null
  if (!transactionType) return null

  const problems: string[] = []
  if (typeof body.city !== 'string' || !isCanonicalCity(body.city)) problems.push('Run is not a Tel Aviv search.')
  for (const key of Object.keys(body)) {
    if (MADLAN_OUTPUT_OPTIONS.has(key)) continue
    if (MADLAN_NARROWING_FLAGS.includes(key)) {
      if (body[key] === true) problems.push(`Run filters on ${key}, which coverage cannot represent.`)
    } else if (!MADLAN_ALLOWED_KEYS.has(key)) {
      problems.push(`Unknown Madlan input "${key}".`)
    }
  }

  let neighborhoods: string[] | null = null
  if (body.neighbourhood !== undefined && body.neighbourhood !== null && body.neighbourhood !== '') {
    const canonical = typeof body.neighbourhood === 'string' ? ALIAS_TO_CANONICAL.get(aliasKey(body.neighbourhood)) : null
    if (canonical) neighborhoods = [canonical]
    else {
      neighborhoods = []
      problems.push(`Madlan neighbourhood "${String(body.neighbourhood)}" does not map to a canonical neighborhood.`)
    }
  }

  return {
    transaction_type: transactionType,
    scope_kind: neighborhoods ? 'neighborhoods' : 'city',
    neighborhoods,
    group_urls: null,
    group_windows: null,
    min_rooms: positiveNumber(body.minRooms),
    max_rooms: positiveNumber(body.maxRooms),
    min_price: positiveNumber(body.minPrice),
    max_price: positiveNumber(body.maxPrice),
    max_items: positiveNumber(body.maxItems),
    problems,
  }
}

/** A run that returned as many items as its cap may have stopped early. A run with no known cap is assumed capped. */
export function madlanRunTruncated(itemCount: number, maxItems: number | null) {
  return maxItems === null || itemCount >= maxItems
}

// ---------- Facebook scope ----------

const FB_POST_PATH = /\/groups\/([^/]+)\/(?:posts|permalink)\/\d+/

/** Group id as it appears in a post URL, lowercased so slugs compare case-insensitively. */
export function facebookGroupKey(postUrl: string | null | undefined): string | null {
  if (!postUrl) return null
  try {
    const url = new URL(postUrl)
    const match = FB_POST_PATH.exec(url.pathname)
    const id = match?.[1] ?? (url.pathname.includes('/permalink') ? url.searchParams.get('id') : null)
    return id ? id.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Scope of a Facebook scan. Each group is only covered back to the oldest post the scan returned for it,
 * because the actor reads just the newest maxPostsPerGroup posts. Groups that returned no dated post get no window.
 */
export function facebookRunScope(input: unknown, items: unknown[]): RunScope | null {
  const startUrls = (input as { startUrls?: unknown } | null)?.startUrls
  if (!Array.isArray(startUrls) || startUrls.length === 0) return null
  const problems: string[] = []
  const groupUrls: string[] = []
  for (const raw of startUrls) {
    const url = typeof raw === 'string' ? canonicalFacebookGroupUrl(raw) : null
    if (url) groupUrls.push(url)
    else problems.push(`Invalid group start URL: ${String(raw)}`)
  }

  const windows: Record<string, string> = {}
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const { url, time } = item as { url?: unknown; time?: unknown }
    const key = facebookGroupKey(typeof url === 'string' ? url : null)
    const at = isoOrNull(time)
    if (!key || !at) continue
    if (!windows[key] || at < windows[key]) windows[key] = at
  }

  return {
    transaction_type: null,
    scope_kind: 'groups',
    neighborhoods: null,
    group_urls: groupUrls,
    group_windows: windows,
    min_rooms: null,
    max_rooms: null,
    min_price: null,
    max_price: null,
    problems,
  }
}

// ---------- run row ----------

/** Above this share of failed items, processing itself is suspect and the run's coverage is not trusted. */
export const SYSTEMIC_FAILURE_RATIO = 0.1

/**
 * Whether a run's coverage can be trusted. Only coverage problems make it `partial`:
 * an unreadable or unsupported scope, a truncated result set, or a systemic import failure
 * (nothing imported, or more than SYSTEMIC_FAILURE_RATIO of items failed).
 * A few malformed items are kept in items_failed for auditing but do not invalidate coverage.
 * Non-succeeded actor runs and unreadable datasets never reach this point; the webhooks stop before recording.
 */
export function refreshRunStatus(args: {
  problems: string[]
  truncated: boolean
  itemCount: number
  itemsImported: number
  itemsFailed: number
}): RefreshRunStatus {
  if (args.problems.length > 0 || args.truncated) return 'partial'
  if (args.itemsFailed > 0) {
    if (args.itemsImported === 0) return 'partial'
    if (args.itemCount === 0 || args.itemsFailed / args.itemCount > SYSTEMIC_FAILURE_RATIO) return 'partial'
  }
  return 'succeeded'
}

export function buildRefreshRunRow(args: {
  source: RefreshSource
  meta: RunMeta & { runId: string }
  scope: RunScope
  seenAt: string
  itemCount: number
  itemsImported: number
  itemsFailed: number
  truncated: boolean
}): RefreshRunRow {
  const { scope } = args
  return {
    source: args.source,
    transaction_type: scope.transaction_type,
    actor_run_id: args.meta.runId,
    started_at: args.meta.startedAt,
    finished_at: args.seenAt,
    status: refreshRunStatus({
      problems: scope.problems,
      truncated: args.truncated,
      itemCount: args.itemCount,
      itemsImported: args.itemsImported,
      itemsFailed: args.itemsFailed,
    }),
    scope_kind: scope.scope_kind,
    neighborhoods: scope.neighborhoods,
    group_urls: scope.group_urls,
    group_windows: scope.group_windows,
    min_rooms: scope.min_rooms,
    max_rooms: scope.max_rooms,
    min_price: scope.min_price,
    max_price: scope.max_price,
    item_count: args.itemCount,
    items_imported: args.itemsImported,
    items_failed: args.itemsFailed,
    truncated: args.truncated,
  }
}

// ---------- coverage and status ----------

export type FreshnessListing = {
  source: string | null
  transaction_type: string | null
  city?: string | null
  neighborhood: string | null
  rooms: number | null
  price: number | null
  source_url: string | null
  published_at: string | null
  last_seen_at: string | null
}

export type CoverageRun = Pick<
  RefreshRunRow,
  | 'source'
  | 'transaction_type'
  | 'finished_at'
  | 'status'
  | 'truncated'
  | 'scope_kind'
  | 'neighborhoods'
  | 'group_windows'
  | 'min_rooms'
  | 'max_rooms'
  | 'min_price'
  | 'max_price'
>

function withinRange(value: number | null, min: number | null, max: number | null) {
  if (min === null && max === null) return true
  if (value === null) return false
  return (min === null || value >= min) && (max === null || value <= max)
}

/** Whether this run counts against the listing: right source, successful, complete, and its scope could have returned it. */
export function runCoversListing(run: CoverageRun, listing: FreshnessListing): boolean {
  const source = listing.source?.trim().toLowerCase()
  if (run.source !== source || run.status !== 'succeeded' || run.truncated) return false

  if (run.source === 'facebook') {
    const key = facebookGroupKey(listing.source_url)
    const oldest = key ? run.group_windows?.[key] : undefined
    const posted = listing.published_at ? Date.parse(listing.published_at) : NaN
    return !!oldest && Number.isFinite(posted) && posted > Date.parse(oldest)
  }

  if (run.transaction_type !== listing.transaction_type) return false
  if (listing.city !== undefined && !isCanonicalCity(listing.city)) return false
  if (run.scope_kind === 'neighborhoods') {
    if (!listing.neighborhood || !run.neighborhoods?.includes(listing.neighborhood)) return false
  } else if (run.scope_kind !== 'city') {
    return false
  }
  return withinRange(listing.rooms, run.min_rooms, run.max_rooms) && withinRange(listing.price, run.min_price, run.max_price)
}

export type FreshnessStatus = 'legacy' | 'active' | 'stale' | 'inactive'

export const FRESHNESS_THRESHOLDS: Record<RefreshSource, { staleDays: number; inactiveDays: number }> = {
  yad2: { staleDays: 3, inactiveDays: 7 },
  madlan: { staleDays: 3, inactiveDays: 7 },
  facebook: { staleDays: 7, inactiveDays: 14 },
}
const STALE_MISSES = 2
const INACTIVE_MISSES = 3
const DAY_MS = 24 * 60 * 60 * 1000

export type Freshness = { status: FreshnessStatus; misses: number; firstMissAt: string | null }

/**
 * A miss is a covering run that finished after the listing was last seen (a run that saw it sets
 * last_seen_at to its own finish time). Legacy listings (never seen since the migration) count every
 * recorded run, all of which postdate the migration. Age is measured from the first miss, not from last_seen_at.
 */
export function deriveFreshness(listing: FreshnessListing, runs: CoverageRun[], now: Date): Freshness {
  const lastSeen = listing.last_seen_at ? Date.parse(listing.last_seen_at) : null
  const missTimes = runs
    .filter((run) => runCoversListing(run, listing))
    .map((run) => Date.parse(run.finished_at))
    .filter((t) => Number.isFinite(t) && (lastSeen === null || t > lastSeen))
    .sort((a, b) => a - b)

  const misses = missTimes.length
  const firstMissAt = misses > 0 ? new Date(missTimes[0]).toISOString() : null
  const source = listing.source?.trim().toLowerCase() as RefreshSource
  const thresholds = FRESHNESS_THRESHOLDS[source]
  const baseline: FreshnessStatus = lastSeen === null ? 'legacy' : 'active'
  if (!thresholds || misses === 0) return { status: baseline, misses, firstMissAt }

  const ageDays = (now.getTime() - missTimes[0]) / DAY_MS
  if (misses >= INACTIVE_MISSES && ageDays >= thresholds.inactiveDays) return { status: 'inactive', misses, firstMissAt }
  if (misses >= STALE_MISSES && ageDays >= thresholds.staleDays) return { status: 'stale', misses, firstMissAt }
  return { status: baseline, misses, firstMissAt }
}

const STATUS_RANK: Record<FreshnessStatus, number> = { active: 0, legacy: 1, stale: 2, inactive: 3 }

/** A merged card takes the most active status of the listings merged into it. */
export function mostActiveStatus(statuses: FreshnessStatus[]): FreshnessStatus {
  return statuses.reduce<FreshnessStatus>(
    (best, s) => (STATUS_RANK[s] < STATUS_RANK[best] ? s : best),
    statuses[0] ?? 'legacy',
  )
}

/** Later of two ISO timestamps, so an out-of-order webhook never moves last_seen_at backwards. */
export function laterTimestamp(existing: string | null | undefined, incoming: string) {
  if (!existing) return incoming
  const a = Date.parse(existing)
  const b = Date.parse(incoming)
  return Number.isFinite(a) && a > b ? existing : incoming
}
