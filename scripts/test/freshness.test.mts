/**
 * Refresh coverage and listing freshness. Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/freshness.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildRefreshRunRow,
  deriveFreshness,
  extractRunMeta,
  facebookGroupKey,
  facebookRunScope,
  laterTimestamp,
  madlanRunScope,
  madlanRunTruncated,
  mostActiveStatus,
  runCoversListing,
  yad2RunScope,
  yad2RunTruncated,
  YAD2_PAGE_SIZE,
  type CoverageRun,
  type FreshnessListing,
} from '../../lib/freshness.ts'
import { upsertPropertyBySourceUrl, recordRefreshRun } from '../../lib/upsert-property.ts'

const TLV = 'topArea=2&area=1&city=5000'
const yad2Input = (...urls: string[]) => ({ start_urls: urls.map((url) => ({ url })) })
const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const at = (days: number) => new Date(T0 + days * DAY).toISOString()

function listing(overrides: Partial<FreshnessListing> = {}): FreshnessListing {
  return {
    source: 'yad2',
    transaction_type: 'rent',
    city: 'Tel Aviv',
    neighborhood: 'Neve Tzedek',
    rooms: 3,
    price: 9000,
    source_url: 'https://www.yad2.co.il/item/abc',
    published_at: null,
    last_seen_at: null,
    ...overrides,
  }
}

function run(overrides: Partial<CoverageRun> = {}): CoverageRun {
  return {
    source: 'yad2',
    transaction_type: 'rent',
    finished_at: at(0),
    status: 'succeeded',
    truncated: false,
    scope_kind: 'neighborhoods',
    neighborhoods: ['Neve Tzedek'],
    group_windows: null,
    min_rooms: null,
    max_rooms: null,
    min_price: null,
    max_price: null,
    ...overrides,
  }
}

// ---------- run metadata ----------

test('extractRunMeta reads run id and times from an Apify webhook payload', () => {
  const meta = extractRunMeta({
    eventType: 'ACTOR.RUN.SUCCEEDED',
    resource: { id: 'run123', startedAt: '2026-11-01T09:00:00Z', finishedAt: '2026-11-01T09:05:00Z' },
  })
  assert.deepEqual(meta, {
    runId: 'run123',
    startedAt: '2026-11-01T09:00:00.000Z',
    finishedAt: '2026-11-01T09:05:00.000Z',
  })
  assert.deepEqual(extractRunMeta({}), { runId: null, startedAt: null, finishedAt: null })
  assert.equal(extractRunMeta({ eventData: { actorRunId: 'r2' } }).runId, 'r2')
})

// ---------- Yad2 scope ----------

test('Yad2: a sale + Neve Tzedek run records sale, that neighborhood and its filters', () => {
  const scope = yad2RunScope(
    yad2Input(`https://www.yad2.co.il/realestate/forsale?${TLV}&neighborhood=848&minRooms=3&maxRooms=4&maxPrice=5000000`),
  )
  assert.ok(scope)
  assert.equal(scope.transaction_type, 'sale')
  assert.equal(scope.scope_kind, 'neighborhoods')
  assert.deepEqual(scope.neighborhoods, ['Neve Tzedek'])
  assert.equal(scope.min_rooms, 3)
  assert.equal(scope.max_rooms, 4)
  assert.equal(scope.max_price, 5000000)
  assert.equal(scope.min_price, null)
  assert.deepEqual(scope.problems, [])
})

test('Yad2: a run without neighborhood= is Tel Aviv-wide', () => {
  const scope = yad2RunScope(yad2Input(`https://www.yad2.co.il/realestate/rent?${TLV}`))
  assert.equal(scope?.scope_kind, 'city')
  assert.equal(scope?.neighborhoods, null)
  assert.deepEqual(scope?.problems, [])
})

test('Yad2: split or unconfirmed neighborhood IDs cannot age listings', () => {
  for (const id of ['1483', '1461', '204', '99999']) {
    const scope = yad2RunScope(yad2Input(`https://www.yad2.co.il/realestate/rent?${TLV}&neighborhood=${id}`))
    assert.ok(scope && scope.problems.length > 0, `id ${id} should be a problem`)
  }
})

test('Yad2: unknown filters, non-Tel Aviv and unreadable input', () => {
  assert.ok(yad2RunScope(yad2Input(`https://www.yad2.co.il/realestate/rent?${TLV}&parking=1`))!.problems.length > 0)
  assert.ok(yad2RunScope(yad2Input('https://www.yad2.co.il/realestate/rent?topArea=2&area=3&city=6600'))!.problems.length > 0)
  assert.equal(yad2RunScope(null), null)
  assert.equal(yad2RunScope({ start_urls: [] }), null)
})

test('Yad2: a full results page counts as truncated', () => {
  assert.equal(yad2RunTruncated(YAD2_PAGE_SIZE), true)
  assert.equal(yad2RunTruncated(YAD2_PAGE_SIZE - 1), false)
})

// ---------- Madlan scope ----------

test('Madlan: dealType, neighbourhood and filters become the scope', () => {
  const scope = madlanRunScope({
    city: 'Tel Aviv',
    dealType: 'buy',
    neighbourhood: 'נווה צדק',
    minRooms: 2,
    maxPrice: 4000000,
    maxItems: 50,
  })
  assert.ok(scope)
  assert.equal(scope.transaction_type, 'sale')
  assert.deepEqual(scope.neighborhoods, ['Neve Tzedek'])
  assert.equal(scope.min_rooms, 2)
  assert.equal(scope.max_price, 4000000)
  assert.equal(scope.max_items, 50)
  assert.deepEqual(scope.problems, [])
})

test('Madlan: amenity filters, unknown neighbourhoods and other cities are problems', () => {
  assert.ok(madlanRunScope({ city: 'Tel Aviv', dealType: 'rent', requireParking: true })!.problems.length > 0)
  assert.deepEqual(madlanRunScope({ city: 'Tel Aviv', dealType: 'rent', requireParking: false })!.problems, [])
  assert.ok(madlanRunScope({ city: 'Tel Aviv', dealType: 'rent', neighbourhood: 'Atlantis' })!.problems.length > 0)
  assert.ok(madlanRunScope({ city: 'Haifa', dealType: 'rent' })!.problems.length > 0)
  assert.equal(madlanRunScope({ city: 'Tel Aviv' }), null)
  assert.equal(madlanRunScope(null), null)
})

test('Madlan: hitting maxItems, or an unknown cap, is truncated', () => {
  assert.equal(madlanRunTruncated(50, 50), true)
  assert.equal(madlanRunTruncated(49, 50), false)
  assert.equal(madlanRunTruncated(3, null), true)
})

// ---------- Facebook scope ----------

test('facebookGroupKey reads the group from post and permalink URLs', () => {
  assert.equal(facebookGroupKey('https://www.facebook.com/groups/123456/posts/789'), '123456')
  assert.equal(facebookGroupKey('https://www.facebook.com/groups/TelAvivApartments/permalink/789/'), 'telavivapartments')
  assert.equal(facebookGroupKey('https://www.facebook.com/photo/?fbid=1'), null)
  assert.equal(facebookGroupKey(null), null)
})

test('Facebook: windows hold the oldest post per scanned group', () => {
  const scope = facebookRunScope({ startUrls: ['https://www.facebook.com/groups/111', 'https://m.facebook.com/groups/222/'] }, [
    { url: 'https://www.facebook.com/groups/111/posts/1', time: '2026-11-03T00:00:00Z' },
    { url: 'https://www.facebook.com/groups/111/posts/2', time: '2026-10-30T00:00:00Z' },
    { url: 'https://www.facebook.com/groups/222/posts/3', time: '2026-11-02T00:00:00Z' },
    { url: 'https://www.facebook.com/groups/222/posts/4' },
    { foo: 'bar' },
  ])
  assert.ok(scope)
  assert.equal(scope.scope_kind, 'groups')
  assert.equal(scope.transaction_type, null)
  assert.deepEqual(scope.group_urls, ['https://www.facebook.com/groups/111', 'https://www.facebook.com/groups/222'])
  assert.deepEqual(scope.group_windows, { '111': '2026-10-30T00:00:00.000Z', '222': '2026-11-02T00:00:00.000Z' })
  assert.equal(facebookRunScope(null, []), null)
})

// ---------- run row ----------

test('buildRefreshRunRow: succeeded with a clean scope; scope problems make it partial', () => {
  const scope = yad2RunScope(yad2Input(`https://www.yad2.co.il/realestate/rent?${TLV}&neighborhood=848`))!
  const base = {
    source: 'yad2' as const,
    meta: { runId: 'r1', startedAt: at(-1), finishedAt: at(0) },
    scope,
    seenAt: at(0),
    itemCount: 10,
    itemsImported: 10,
    itemsFailed: 0,
    truncated: false,
  }
  const ok = buildRefreshRunRow(base)
  assert.equal(ok.status, 'succeeded')
  assert.equal(ok.actor_run_id, 'r1')
  assert.equal(ok.finished_at, at(0))
  assert.deepEqual(ok.neighborhoods, ['Neve Tzedek'])
  assert.equal(buildRefreshRunRow({ ...base, scope: { ...scope, problems: ['x'] } }).status, 'partial')
})

test('Madlan production run FhwteNF48W5JO99uG (exact saved INPUT) records as succeeded', () => {
  const input = {
    city: 'Tel Aviv',
    dealType: 'rent',
    maxItems: 50,
    neighbourhood: 'נווה צדק',
    excludeAgents: false,
    requireParking: false,
    requireElevator: false,
    requireBalcony: false,
    requireSecureRoom: false,
    enrichInsights: false,
    includeContactMetadata: false,
  }
  const scope = madlanRunScope(input)!
  assert.deepEqual(scope.problems, [])
  assert.equal(scope.transaction_type, 'rent')
  assert.equal(scope.scope_kind, 'neighborhoods')
  assert.deepEqual(scope.neighborhoods, ['Neve Tzedek'])
  assert.equal(scope.max_items, 50)

  const truncated = madlanRunTruncated(31, scope.max_items)
  assert.equal(truncated, false)
  const row = buildRefreshRunRow({
    source: 'madlan',
    meta: { runId: 'FhwteNF48W5JO99uG', startedAt: '2026-10-27T12:59:59.123Z', finishedAt: '2026-10-27T13:00:03.951Z' },
    scope,
    seenAt: '2026-10-27T13:00:03.951Z',
    itemCount: 31,
    itemsImported: 31,
    itemsFailed: 0,
    truncated,
  })
  assert.equal(row.status, 'succeeded')
  assert.equal(row.truncated, false)
})

// ---------- coverage completeness vs item import quality ----------

const neveTzedekRent = () => yad2RunScope(yad2Input(`https://www.yad2.co.il/realestate/rent?${TLV}&neighborhood=848`))!
const yad2Row = (overrides: Partial<Parameters<typeof buildRefreshRunRow>[0]> = {}) =>
  buildRefreshRunRow({
    source: 'yad2',
    meta: { runId: 'r-yad2', startedAt: null, finishedAt: at(0) },
    scope: neveTzedekRent(),
    seenAt: at(0),
    itemCount: 29,
    itemsImported: 28,
    itemsFailed: 1,
    truncated: yad2RunTruncated(29),
    ...overrides,
  })

test('Yad2: 29 items with 1 malformed property is still succeeded, items_failed kept for audit', () => {
  const row = yad2Row()
  assert.equal(row.status, 'succeeded')
  assert.equal(row.items_failed, 1)
  assert.equal(row.items_imported, 28)
  assert.equal(row.truncated, false)
  assert.deepEqual(row.neighborhoods, ['Neve Tzedek'])
})

test('Yad2: a truncated run is partial', () => {
  const row = yad2Row({ itemCount: YAD2_PAGE_SIZE, itemsImported: YAD2_PAGE_SIZE, itemsFailed: 0, truncated: yad2RunTruncated(YAD2_PAGE_SIZE) })
  assert.equal(row.truncated, true)
  assert.equal(row.status, 'partial')
})

test('Yad2: an unreadable or unsupported scope is partial', () => {
  assert.equal(yad2RunScope({ start_urls: [] }), null)
  const unknownFilter = yad2RunScope(yad2Input(`https://www.yad2.co.il/realestate/rent?${TLV}&parking=1`))!
  assert.equal(yad2Row({ scope: unknownFilter, itemsFailed: 0, itemsImported: 29 }).status, 'partial')
  const splitNeighborhood = yad2RunScope(yad2Input(`https://www.yad2.co.il/realestate/rent?${TLV}&neighborhood=1483`))!
  assert.equal(yad2Row({ scope: splitNeighborhood, itemsFailed: 0, itemsImported: 29 }).status, 'partial')
})

test('a real dataset-processing failure is partial', () => {
  assert.equal(yad2Row({ itemCount: 29, itemsImported: 0, itemsFailed: 29 }).status, 'partial')
  assert.equal(yad2Row({ itemCount: 29, itemsImported: 20, itemsFailed: 9 }).status, 'partial')
  assert.equal(yad2Row({ itemCount: 10, itemsImported: 9, itemsFailed: 1 }).status, 'succeeded')
  assert.equal(yad2Row({ itemCount: 10, itemsImported: 8, itemsFailed: 2 }).status, 'partial')
  assert.equal(yad2Row({ itemCount: 0, itemsImported: 0, itemsFailed: 0 }).status, 'succeeded')
})

const madlanInput = {
  city: 'Tel Aviv',
  dealType: 'rent',
  neighbourhood: 'נווה צדק',
  maxItems: 50,
  excludeAgents: false,
  enrichInsights: true,
  includeContactMetadata: true,
}
const madlanRow = (itemCount: number, itemsFailed = 0) => {
  const scope = madlanRunScope(madlanInput)!
  return buildRefreshRunRow({
    source: 'madlan',
    meta: { runId: 'r-madlan', startedAt: null, finishedAt: at(0) },
    scope,
    seenAt: at(0),
    itemCount,
    itemsImported: itemCount - itemsFailed,
    itemsFailed,
    truncated: madlanRunTruncated(itemCount, scope.max_items),
  })
}

test('Madlan: excludeAgents, enrichInsights and includeContactMetadata are ignored', () => {
  const scope = madlanRunScope(madlanInput)!
  assert.deepEqual(scope.problems, [])
  assert.deepEqual(scope.neighborhoods, ['Neve Tzedek'])
  assert.equal(scope.transaction_type, 'rent')
})

test('Madlan: a valid non-truncated run is succeeded', () => {
  const row = madlanRow(31, 1)
  assert.equal(row.truncated, false)
  assert.equal(row.status, 'succeeded')
  assert.equal(row.items_failed, 1)
})

test('Madlan: hitting maxItems is truncated and partial', () => {
  const row = madlanRow(50)
  assert.equal(row.truncated, true)
  assert.equal(row.status, 'partial')
})

// ---------- coverage ----------

test('coverage: source, deal type, neighborhood, rooms and price must all fit', () => {
  const l = listing()
  assert.equal(runCoversListing(run(), l), true)
  assert.equal(runCoversListing(run({ source: 'madlan' }), l), false)
  assert.equal(runCoversListing(run({ transaction_type: 'sale' }), l), false)
  assert.equal(runCoversListing(run({ neighborhoods: ['Florentin'] }), l), false)
  assert.equal(runCoversListing(run({ scope_kind: 'city', neighborhoods: null }), listing({ neighborhood: null })), true)
  assert.equal(runCoversListing(run({ min_rooms: 4 }), l), false)
  assert.equal(runCoversListing(run({ max_price: 8000 }), l), false)
  assert.equal(runCoversListing(run({ min_rooms: 2, max_price: 10000 }), l), true)
})

test('coverage: unknown rooms or price is not covered by a run filtering on that field', () => {
  assert.equal(runCoversListing(run({ min_rooms: 2 }), listing({ rooms: null })), false)
  assert.equal(runCoversListing(run({ max_price: 10000 }), listing({ price: null })), false)
  assert.equal(runCoversListing(run(), listing({ rooms: null, price: null })), true)
})

test('coverage: partial, failed and truncated runs never count', () => {
  const l = listing()
  assert.equal(runCoversListing(run({ status: 'partial' }), l), false)
  assert.equal(runCoversListing(run({ status: 'failed' }), l), false)
  assert.equal(runCoversListing(run({ truncated: true }), l), false)
})

test('coverage: Facebook posts only count inside their group window', () => {
  const fbRun = run({
    source: 'facebook',
    transaction_type: null,
    scope_kind: 'groups',
    neighborhoods: null,
    group_windows: { '111': '2026-10-30T00:00:00.000Z' },
  })
  const post = (url: string, published: string | null) =>
    listing({ source: 'facebook', transaction_type: 'sale', source_url: url, published_at: published })
  assert.equal(runCoversListing(fbRun, post('https://www.facebook.com/groups/111/posts/9', '2026-10-31T00:00:00Z')), true)
  assert.equal(runCoversListing(fbRun, post('https://www.facebook.com/groups/111/posts/9', '2026-10-29T00:00:00Z')), false)
  assert.equal(runCoversListing(fbRun, post('https://www.facebook.com/groups/111/posts/9', null)), false)
  assert.equal(runCoversListing(fbRun, post('https://www.facebook.com/groups/222/posts/9', '2026-11-01T00:00:00Z')), false)
  assert.equal(runCoversListing(fbRun, post('https://www.facebook.com/telaviv/posts/9', '2026-11-01T00:00:00Z')), false)
})

// ---------- status ----------

test('status: legacy rows with no recorded runs stay legacy (nothing hidden after the migration)', () => {
  assert.equal(deriveFreshness(listing(), [], new Date(at(30))).status, 'legacy')
  assert.equal(deriveFreshness(listing({ source: 'facebook' }), [], new Date(at(30))).status, 'legacy')
})

test('status: one miss never changes anything, however old', () => {
  const f = deriveFreshness(listing(), [run({ finished_at: at(0) })], new Date(at(60)))
  assert.equal(f.status, 'legacy')
  assert.equal(f.misses, 1)
})

test('status: Yad2 stale needs 2 misses and 3 days since the first; inactive needs 3 misses and 7 days', () => {
  const l = listing({ last_seen_at: at(-1) })
  const two = [run({ finished_at: at(0) }), run({ finished_at: at(1) })]
  assert.equal(deriveFreshness(l, two, new Date(at(2.9))).status, 'active')
  assert.equal(deriveFreshness(l, two, new Date(at(3))).status, 'stale')
  assert.equal(deriveFreshness(l, two, new Date(at(30))).status, 'stale')
  const three = [...two, run({ finished_at: at(2) })]
  assert.equal(deriveFreshness(l, three, new Date(at(6.9))).status, 'stale')
  assert.equal(deriveFreshness(l, three, new Date(at(7))).status, 'inactive')
})

test('status: Facebook uses 7 / 14 days', () => {
  const l = listing({
    source: 'facebook',
    source_url: 'https://www.facebook.com/groups/111/posts/9',
    published_at: at(-2),
    last_seen_at: at(-1),
  })
  const fb = (days: number) =>
    run({
      source: 'facebook',
      transaction_type: null,
      scope_kind: 'groups',
      neighborhoods: null,
      group_windows: { '111': at(-5) },
      finished_at: at(days),
    })
  const runs = [fb(0), fb(1), fb(2)]
  assert.equal(deriveFreshness(l, runs, new Date(at(6))).status, 'active')
  assert.equal(deriveFreshness(l, runs, new Date(at(7))).status, 'stale')
  assert.equal(deriveFreshness(l, runs, new Date(at(14))).status, 'inactive')
})

test('status: runs before the last sighting are not misses; a new sighting resets ageing', () => {
  const runs = [run({ finished_at: at(0) }), run({ finished_at: at(1) }), run({ finished_at: at(2) })]
  const seenAfter = listing({ last_seen_at: at(2) })
  const f = deriveFreshness(seenAfter, runs, new Date(at(30)))
  assert.equal(f.status, 'active')
  assert.equal(f.misses, 0)
})

test('status: a legacy listing ages from its first miss, not from created_at', () => {
  const runs = [run({ finished_at: at(0) }), run({ finished_at: at(1) })]
  assert.equal(deriveFreshness(listing(), runs, new Date(at(2))).status, 'legacy')
  assert.equal(deriveFreshness(listing(), runs, new Date(at(3))).status, 'stale')
})

test('status: runs outside the listing scope never age it', () => {
  const l = listing({ neighborhood: 'Old North', last_seen_at: at(-1) })
  const runs = [0, 1, 2].map((d) => run({ finished_at: at(d), neighborhoods: ['Neve Tzedek'] }))
  assert.equal(deriveFreshness(l, runs, new Date(at(30))).status, 'active')
})

test('merged cards take the most active status', () => {
  assert.equal(mostActiveStatus(['inactive', 'active']), 'active')
  assert.equal(mostActiveStatus(['stale', 'legacy']), 'legacy')
  assert.equal(mostActiveStatus(['inactive', 'stale']), 'stale')
  assert.equal(mostActiveStatus([]), 'legacy')
})

test('laterTimestamp never moves last_seen_at backwards', () => {
  assert.equal(laterTimestamp(null, at(1)), at(1))
  assert.equal(laterTimestamp(at(2), at(1)), at(2))
  assert.equal(laterTimestamp(at(1), at(2)), at(2))
})

// ---------- upsert + run recording against a fake Supabase client ----------

type Call = { table: string; op: string; payload?: unknown; options?: unknown }

function fakeSupabase(existing: { id: number; last_seen_at: string | null } | null, upsertReturns: unknown[] = [{ id: 1 }]) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      let op = 'select'
      let payload: unknown
      let options: unknown
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          calls.push({ table, op: 'lookup' })
          return { data: existing, error: null }
        },
        update: (row: unknown) => {
          op = 'update'
          payload = row
          return chain
        },
        insert: (row: unknown) => {
          op = 'insert'
          payload = row
          return chain
        },
        upsert: (row: unknown, opts: unknown) => {
          op = 'upsert'
          payload = row
          options = opts
          return {
            select: async () => {
              calls.push({ table, op, payload, options })
              return { data: upsertReturns, error: null }
            },
          }
        },
        single: async () => {
          calls.push({ table, op, payload })
          return { data: { id: existing?.id ?? 99 }, error: null }
        },
      })
      return chain
    },
  }
  return { client: client as never, calls }
}

const property = { source: 'yad2', source_url: 'https://www.yad2.co.il/item/abc', title: 'x' } as never

test('upsert: insert sets last_seen_at and never sends first_seen_at', async () => {
  const { client, calls } = fakeSupabase(null)
  const result = await upsertPropertyBySourceUrl(client, property, { seenAt: at(0) })
  assert.equal(result.ok && result.action, 'created')
  const insert = calls.find((c) => c.op === 'insert')!.payload as Record<string, unknown>
  assert.equal(insert.last_seen_at, at(0))
  assert.equal('first_seen_at' in insert, false)
})

test('upsert: update sets last_seen_at to the later time and never sends first_seen_at', async () => {
  const newer = fakeSupabase({ id: 5, last_seen_at: at(-3) })
  await upsertPropertyBySourceUrl(newer.client, property, { seenAt: at(0) })
  const update = newer.calls.find((c) => c.op === 'update')!.payload as Record<string, unknown>
  assert.equal(update.last_seen_at, at(0))
  assert.equal('first_seen_at' in update, false)

  const older = fakeSupabase({ id: 5, last_seen_at: at(3) })
  await upsertPropertyBySourceUrl(older.client, property, { seenAt: at(0) })
  assert.equal((older.calls.find((c) => c.op === 'update')!.payload as Record<string, unknown>).last_seen_at, at(3))
})

test('upsert: without seenAt (manual import) last_seen_at is not touched', async () => {
  const { client, calls } = fakeSupabase({ id: 5, last_seen_at: null })
  await upsertPropertyBySourceUrl(client, property)
  const update = calls.find((c) => c.op === 'update')!.payload as Record<string, unknown>
  assert.equal('last_seen_at' in update, false)
})

test('recordRefreshRun ignores a webhook retry for the same run', async () => {
  const scope = madlanRunScope({ city: 'Tel Aviv', dealType: 'rent', maxItems: 50 })!
  const row = buildRefreshRunRow({
    source: 'madlan',
    meta: { runId: 'run-x', startedAt: null, finishedAt: at(0) },
    scope,
    seenAt: at(0),
    itemCount: 12,
    itemsImported: 12,
    itemsFailed: 0,
    truncated: madlanRunTruncated(12, scope.max_items),
  })
  const first = fakeSupabase(null, [{ id: 1 }])
  const recorded = await recordRefreshRun(first.client, row)
  assert.equal(recorded.recorded, true)
  const call = first.calls.find((c) => c.op === 'upsert')!
  assert.deepEqual(call.options, { onConflict: 'actor_run_id', ignoreDuplicates: true })
  assert.equal((call.payload as { source: string }).source, 'madlan')

  const retry = fakeSupabase(null, [])
  const again = await recordRefreshRun(retry.client, row)
  assert.equal(again.recorded, false)
  assert.equal(again.duplicate, true)
})

// Production run 3i8PDa9heXxl5aguJ (27 Oct): the table had no GRANTs, so PostgREST answered 42501.
test('recordRefreshRun reports a permission-denied insert without throwing', async () => {
  const scope = yad2RunScope({
    start_urls: [{ url: 'https://www.yad2.co.il/realestate/rent?topArea=2&area=1&city=5000&neighborhood=1483' }],
  })!
  const row = buildRefreshRunRow({
    source: 'yad2',
    meta: { runId: '3i8PDa9heXxl5aguJ', startedAt: null, finishedAt: '2026-10-27T12:45:11.999Z' },
    scope,
    seenAt: '2026-10-27T12:45:11.999Z',
    itemCount: 29,
    itemsImported: 28,
    itemsFailed: 1,
    truncated: yad2RunTruncated(29),
  })
  const denied = {
    from: () => ({
      upsert: () => ({
        select: async () => ({
          data: null,
          error: { code: '42501', message: 'permission denied for table source_refresh_runs' },
        }),
      }),
    }),
  }
  const result = await recordRefreshRun(denied as never, row)
  assert.deepEqual(result, {
    recorded: false,
    status: 'partial',
    error: 'permission denied for table source_refresh_runs',
  })
  assert.equal(row.truncated, false)
})
