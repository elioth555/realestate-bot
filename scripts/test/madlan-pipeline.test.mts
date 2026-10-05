/**
 * Madlan pipeline tests. Offline: no Apify run, no Supabase. Network is stubbed.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/madlan-pipeline.test.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { importMadlanItems, type MadlanImportDeps } from '../../lib/madlan-import.ts'
import { mapMadlanItem } from '../../lib/madlan-mapper.ts'
import {
  buildMadlanActorInputs,
  startMadlanRuns,
  toMadlanNeighbourhood,
  validateMadlanCriteria,
} from '../../lib/madlan-search.ts'

const sample: Record<string, unknown> = JSON.parse(
  readFileSync(new URL('../fixtures/madlan-sample.json', import.meta.url), 'utf8'),
)
const item = (changes: Record<string, unknown>) => ({ ...sample, ...changes })

/** In-memory stand-in for upsertPropertyBySourceUrl + replacePropertyPhotos. */
function fakeStore(opts: { failPhotosFor?: string; throwPhotosFor?: string; failUpsertFor?: string } = {}) {
  const rows = new Map<string, { id: number; row: Record<string, unknown> }>()
  const photos = new Map<number, string[]>()
  let nextId = 1
  const deps: MadlanImportDeps = {
    upsert: async (property) => {
      if (property.source_url === opts.failUpsertFor) return { ok: false, error: 'db down' }
      const existing = rows.get(property.source_url)
      if (existing) {
        existing.row = { ...existing.row, ...property }
        return { ok: true, action: 'updated', id: existing.id }
      }
      const id = nextId++
      rows.set(property.source_url, { id, row: { ...property } })
      return { ok: true, action: 'created', id }
    },
    syncPhotos: async (propertyId, urls) => {
      const url = [...rows.values()].find((r) => r.id === propertyId)?.row.source_url
      if (url === opts.throwPhotosFor) throw new Error('storage exploded')
      if (url === opts.failPhotosFor) {
        photos.set(propertyId, urls.slice(1))
        return { inserted: urls.length - 1, errors: [`${urls[0]}: broken`] }
      }
      photos.set(propertyId, urls)
      return { inserted: urls.length, errors: [] }
    },
  }
  return { deps, rows, photos }
}

test('fixture imports as one created madlan property with ordered photos', async () => {
  // The real sample listing had no photos; add Madlan-CDN-shaped URLs to exercise the photo path.
  const withPhotos = item({
    images: ['https://images2.madlan.co.il/t:nonce:v=2/x/1.jpg', 'https://images2.madlan.co.il/t:nonce:v=2/x/2.jpg'],
  })
  const store = fakeStore()
  const summary = await importMadlanItems([withPhotos], store.deps)
  const expectedPhotos = mapMadlanItem(withPhotos).photoUrls

  assert.equal(summary.total, 1)
  assert.equal(summary.created, 1)
  assert.equal(summary.updated, 0)
  assert.equal(summary.failed, 0)
  assert.equal(summary.photos_inserted, expectedPhotos.length)
  assert.ok(expectedPhotos.length > 0)

  const [{ id, row }] = [...store.rows.values()]
  assert.equal(row.source, 'madlan')
  assert.match(String(row.source_url), /^https:\/\/www\.madlan\.co\.il\//)
  assert.equal(row.description, 'חניה משותפת. מקלט מאובזר ומאורגן.')
  // Structured false flags stay NULL; description resolves the final state on read.
  assert.equal(row.mamad, null)
  assert.deepEqual(store.photos.get(id), expectedPhotos)
})

test('re-import of the same listing updates instead of duplicating', async () => {
  const store = fakeStore()
  await importMadlanItems([sample], store.deps)
  const second = await importMadlanItems([item({ price: 9999 })], store.deps)
  assert.equal(second.created, 0)
  assert.equal(second.updated, 1)
  assert.equal(store.rows.size, 1)
  assert.equal([...store.rows.values()][0].row.price, 9999)
})

test('photos are de-duplicated and keep their order', async () => {
  const [a, b] = ['https://images2.madlan.co.il/a.jpg', 'https://images2.madlan.co.il/b.jpg']
  const store = fakeStore()
  await importMadlanItems([item({ images: [a, b, a, 'not a url', { url: b }] })], store.deps)
  assert.deepEqual([...store.photos.values()][0], [a, b])
})

test('one bad item, one failed upsert and broken photos never stop the batch', async () => {
  const images = ['https://images2.madlan.co.il/p/1.jpg', 'https://images2.madlan.co.il/p/2.jpg']
  const good2 = item({ id: 'second', url: 'https://www.madlan.co.il/listings/second', images })
  const good3 = item({ id: 'third', url: 'https://www.madlan.co.il/listings/third', images })
  const good4 = item({ id: 'fourth', url: 'https://www.madlan.co.il/listings/fourth' })
  const invalid = item({ id: 'nop', url: 'https://www.madlan.co.il/listings/nop', price: null })
  const store = fakeStore({
    failPhotosFor: 'https://www.madlan.co.il/listings/second',
    throwPhotosFor: 'https://www.madlan.co.il/listings/third',
    failUpsertFor: 'https://www.madlan.co.il/listings/fourth',
  })

  const summary = await importMadlanItems([sample, 'garbage', invalid, good2, good3, good4], store.deps)

  assert.equal(summary.total, 6)
  assert.equal(summary.created, 3)
  assert.equal(summary.failed, 3)
  assert.deepEqual(summary.errors.map((e) => e.index), [1, 2, 5])
  assert.match(summary.errors[1].errors.join(' '), /"price" is required/)
  assert.deepEqual(summary.errors[2].errors, ['db down'])
  assert.equal(summary.photo_errors.length, 2)
  assert.ok(summary.photo_errors.some((e) => e.errors.join(' ').includes('storage exploded')))
})

test('actor input uses only confirmed schema fields and omits unset filters', () => {
  const v = validateMadlanCriteria({
    city: 'Tel Aviv',
    transaction_type: 'rent',
    min_price: '5000',
    max_price: 9000.4,
    min_rooms: 2,
    max_rooms: '3.5',
    parking: true,
    elevator: false,
    balcony: true,
    mamad: true,
  })
  assert.ok(v.ok)
  assert.deepEqual(buildMadlanActorInputs(v.data), [
    {
      city: 'Tel Aviv',
      dealType: 'rent',
      maxItems: 50,
      minPrice: 5000,
      maxPrice: 9000,
      minRooms: 2,
      maxRooms: 3.5,
      requireParking: true,
      requireBalcony: true,
      requireSecureRoom: true,
    },
  ])

  const bare = validateMadlanCriteria({ city: 'תל אביב יפו', transaction_type: 'rent' })
  assert.ok(bare.ok)
  assert.deepEqual(buildMadlanActorInputs(bare.data), [{ city: 'Tel Aviv', dealType: 'rent', maxItems: 50 }])
})

test('neighborhoods: one run each in Hebrew; unknown or too many is an error, never ignored', () => {
  assert.equal(toMadlanNeighbourhood('Old North'), 'הצפון הישן')
  assert.equal(toMadlanNeighbourhood('neve tsedek'), 'נווה צדק')
  assert.equal(toMadlanNeighbourhood('נווה זמר'), 'נווה זמר')
  assert.equal(toMadlanNeighbourhood('Atlantis'), null)

  const two = validateMadlanCriteria({ city: 'Tel Aviv', transaction_type: 'rent', neighborhoods: ['Old North', 'Florentin'] })
  assert.ok(two.ok)
  assert.deepEqual(buildMadlanActorInputs(two.data).map((i) => i.neighbourhood), ['הצפון הישן', 'פלורנטין'])

  const unknown = validateMadlanCriteria({ city: 'Tel Aviv', transaction_type: 'rent', neighborhoods: ['Florentin', 'Atlantis'] })
  assert.ok(!unknown.ok)
  assert.match(unknown.errors.join(' '), /Atlantis/)

  const tooMany = validateMadlanCriteria({
    city: 'Tel Aviv',
    transaction_type: 'rent',
    neighborhoods: ['Florentin', 'Old North', 'New North', 'Jaffa'],
  })
  assert.ok(!tooMany.ok)
})

test('unsupported city / sale are rejected', () => {
  assert.ok(!validateMadlanCriteria({ city: 'Haifa', transaction_type: 'rent' }).ok)
  assert.ok(!validateMadlanCriteria({ city: 'Tel Aviv', transaction_type: 'sale' }).ok)
})

test('startMadlanRuns posts one run per input to the configured actor (fetch stubbed)', async () => {
  const calls: { url: string; body: unknown }[] = []
  const realFetch = globalThis.fetch
  process.env.APIFY_API_TOKEN = 'test-token'
  process.env.APIFY_MADLAN_ACTOR_ID = 'swerve/madlan-scraper'
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ data: { id: `run${calls.length}abcdefgh`, status: 'READY' } }), { status: 201 })
  }) as typeof fetch
  try {
    const v = validateMadlanCriteria({ city: 'Tel Aviv', transaction_type: 'rent', neighborhoods: ['Old North', 'Bavli'] })
    assert.ok(v.ok)
    const result = await startMadlanRuns(v.data)
    assert.ok(result.ok)
    assert.equal(result.runs.length, 2)
    assert.equal(calls[0].url, 'https://api.apify.com/v2/acts/swerve~madlan-scraper/runs')
    assert.deepEqual(calls.map((c) => (c.body as { neighbourhood: string }).neighbourhood), ['הצפון הישן', 'בבלי'])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('webhook: auth, ignored events and dataset errors (no Supabase, fetch stubbed)', async () => {
  process.env.APIFY_MADLAN_WEBHOOK_SECRET = 'madlan-secret'
  process.env.APIFY_API_TOKEN = 'test-token'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9'
  process.env.SUPABASE_SECRET_KEY = 'unused'
  const { POST } = await import('../../app/api/apify-madlan-webhook/route.ts')
  const post = (body: unknown, secret?: string) =>
    POST(
      new Request('http://localhost/api/apify-madlan-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify(body),
      }),
    )

  assert.equal((await post({})).status, 401)
  assert.equal((await post({}, 'wrong')).status, 401)

  const failed = await post({ eventType: 'ACTOR.RUN.FAILED', resource: { status: 'FAILED' } }, 'madlan-secret')
  assert.equal(failed.status, 200)
  assert.equal((await failed.json()).skipped, true)

  assert.equal((await post({ eventType: 'ACTOR.RUN.SUCCEEDED', resource: {} }, 'madlan-secret')).status, 400)

  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch
  try {
    const res = await post(
      { eventType: 'ACTOR.RUN.SUCCEEDED', resource: { status: 'SUCCEEDED', defaultDatasetId: 'abc123' } },
      'madlan-secret',
    )
    assert.equal(res.status, 502)
  } finally {
    globalThis.fetch = realFetch
  }
})
