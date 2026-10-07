/**
 * Facebook import pipeline tests. Offline: no Apify run, no Supabase.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/facebook-pipeline.test.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { importFacebookItems, type FacebookImportDeps } from '../../lib/facebook-import.ts'
import { EMPTY_FILTERS } from '../../lib/filters.ts'
import { validatePropertyInput } from '../../lib/import-listing.ts'
import type { Listing } from '../../lib/listings.ts'
import { compileQuery, evaluateListing } from '../../lib/matching/engine.ts'

const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'))
const sample: Record<string, unknown> = load('facebook-sample.json')
const synthetic: Record<string, Record<string, unknown>> = load('facebook-synthetic.json')
const post = (id: string, text: string) => ({
  time: '2026-10-06T09:00:00.000Z',
  authorName: 'Test Author',
  likesCount: 2,
  commentsCount: 1,
  text,
  url: `https://www.facebook.com/groups/938644249820363/posts/${id}/`,
})

function fakeStore(opts: { failUpsertFor?: string; throwUpsertFor?: string } = {}) {
  const rows = new Map<string, { id: number; row: Record<string, unknown> }>()
  let photoCalls = 0
  let nextId = 1
  const deps: FacebookImportDeps = {
    upsert: async (property) => {
      if (property.source_url === opts.throwUpsertFor) throw new Error('connection reset')
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
    syncPhotos: async () => {
      photoCalls++
      return { inserted: 0, errors: [] }
    },
  }
  return { deps, rows, photoCalls: () => photoCalls }
}

test('valid Facebook post with price imports with that price', async () => {
  const store = fakeStore()
  const summary = await importFacebookItems([synthetic.rent_full], store.deps)
  assert.equal(summary.created, 1)
  assert.equal(summary.failed, 0)
  const [{ row }] = [...store.rows.values()]
  assert.equal(row.source, 'facebook')
  assert.equal(row.transaction_type, 'rent')
  assert.equal(row.price, 7800)
})

test('valid Facebook post without price imports with price = null (real sample)', async () => {
  const store = fakeStore()
  const summary = await importFacebookItems([sample], store.deps)
  assert.equal(summary.created, 1, JSON.stringify(summary.errors))
  const [{ row }] = [...store.rows.values()]
  assert.equal(row.price, null)
  assert.equal(row.source_url, 'https://www.facebook.com/groups/938644249820363/posts/3077055422645891/')
  assert.equal(summary.extras[row.source_url as string].fb_post_id, '3077055422645891')
})

test('seeker post is skipped, not imported and not failed', async () => {
  const store = fakeStore()
  const summary = await importFacebookItems([synthetic.seeker], store.deps)
  assert.equal(summary.skipped, 1)
  assert.equal(summary.created + summary.updated + summary.failed, 0)
  assert.equal(store.rows.size, 0)
})

test('malformed posts are rejected with reasons', async () => {
  const store = fakeStore()
  const summary = await importFacebookItems(
    [
      null,
      'not an object',
      { text: 'להשכרה 3 חדרים בתל אביב' }, // no URL
      post('111', ''), // no text
    ],
    store.deps,
  )
  assert.equal(summary.failed, 4)
  assert.equal(store.rows.size, 0)
  assert.ok(summary.errors[2].errors.some((e) => e.includes('source_url')))
  assert.ok(summary.errors[3].errors.some((e) => e.includes('description')))
})

test('ambiguous transaction type is skipped, not failed, and never guessed', async () => {
  const store = fakeStore()
  const ambiguous = [
    post('601', 'דירה יפה 3 חדרים בתל אביב'),
    post('602', 'הזדמנות להשקעה! 4 חדרים בפלורנטין'),
    post('603', 'מתאים למשקיעים, 3 חדרים ברמת גן'),
    post('604', 'דירה מושלמת למגורים, 2 חדרים, 050-1234567'),
    post('605', 'להשכרה או למכירה, 3 חדרים בתל אביב'), // both stated → unclear
  ]
  const summary = await importFacebookItems(ambiguous, store.deps)
  assert.equal(summary.failed, 0, JSON.stringify(summary.errors))
  assert.equal(summary.skipped, 5)
  assert.equal(store.rows.size, 0)
  assert.ok(summary.skips.every((s) => s.reason === 'Transaction type unclear'))
})

test('explicit rent and sale wording still imports normally', async () => {
  const cases: [string, 'rent' | 'sale'][] = [
    ['להשכרה 3 חדרים בתל אביב', 'rent'],
    ['שכירות ארוכת טווח, 3 חדרים', 'rent'],
    ['להשכרה מיידית 2 חדרים', 'rent'],
    ['דירה להשכרה בפלורנטין', 'rent'],
    ['Apartment for rent in Tel Aviv', 'rent'],
    ['Nice flat, rent 6000', 'rent'],
    ['למכירה 4 חדרים ברמת גן', 'sale'],
    ['מכירה ישירה מהבעלים', 'sale'],
    ['דירה למכירה בתל אביב', 'sale'],
    ['נכס למכירה, מתאים גם להשקעה', 'sale'],
    ['Apartment for sale in Tel Aviv', 'sale'],
    ['Sale: 3 rooms, Florentin', 'sale'],
  ]
  const store = fakeStore()
  const summary = await importFacebookItems(cases.map(([text], i) => post(String(700 + i), text)), store.deps)
  assert.equal(summary.failed, 0, JSON.stringify(summary.errors))
  assert.equal(summary.skipped, 0, JSON.stringify(summary.skips))
  assert.equal(summary.created, cases.length)
  cases.forEach(([, expected], i) => {
    const row = store.rows.get(`https://www.facebook.com/groups/938644249820363/posts/${700 + i}/`)?.row
    assert.equal(row?.transaction_type, expected, cases[i][0])
  })
})

test('reimport updates the same source_url instead of duplicating', async () => {
  const store = fakeStore()
  await importFacebookItems([post('333', 'להשכרה 3 חדרים בתל אביב')], store.deps)
  const second = await importFacebookItems([post('333', 'להשכרה 3 חדרים בתל אביב 6,500 ₪')], store.deps)
  assert.equal(second.updated, 1)
  assert.equal(second.created, 0)
  assert.equal(store.rows.size, 1)
  assert.equal([...store.rows.values()][0].row.price, 6500)
})

test('one failing item does not stop the batch', async () => {
  const bad = post('444', 'להשכרה 2 חדרים בתל אביב')
  const thrower = post('555', 'להשכרה 4 חדרים בתל אביב')
  const store = fakeStore({
    failUpsertFor: 'https://www.facebook.com/groups/938644249820363/posts/444/',
    throwUpsertFor: 'https://www.facebook.com/groups/938644249820363/posts/555/',
  })
  const summary = await importFacebookItems([bad, synthetic.rent_full, thrower, sample], store.deps)
  assert.equal(summary.total, 4)
  assert.equal(summary.created, 2)
  assert.equal(summary.failed, 2)
  assert.deepEqual(summary.errors.map((e) => e.index), [0, 2])
})

test('post with no photos imports successfully and never calls the photo pipeline', async () => {
  const store = fakeStore()
  const summary = await importFacebookItems([synthetic.rent_full, sample], store.deps)
  assert.equal(summary.created, 2)
  assert.equal(summary.photos_inserted, 0)
  assert.equal(summary.photo_errors.length, 0)
  assert.equal(store.photoCalls(), 0)
})

test('price filter excludes a null-price Facebook listing; no price filter keeps it', () => {
  const listing = {
    id: '1',
    dealType: 'rent',
    price: 0,
    city: 'Tel Aviv',
    neighborhood: '',
    propertyType: '',
    rooms: 4,
    surface: 0,
    features: {},
    known: { price: false, rooms: true, surface: false },
  } as unknown as Listing
  const run = (changes: Partial<typeof EMPTY_FILTERS>) =>
    evaluateListing(listing, compileQuery({ ...EMPTY_FILTERS, ...changes }, 'all')).status
  assert.notEqual(run({}), 'NO_MATCH')
  assert.equal(run({ maxPrice: '10000' }), 'NO_MATCH')
  assert.equal(run({ minPrice: '1000' }), 'NO_MATCH')
})

test('Yad2 and Madlan validation still require city and price', () => {
  for (const source of ['yad2', 'madlan']) {
    const result = validatePropertyInput({ source, source_url: 'https://example.com/1', transaction_type: 'rent' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.errors.includes('"city" is required.'))
      assert.ok(result.errors.includes('"price" is required.'))
    }
  }
})
