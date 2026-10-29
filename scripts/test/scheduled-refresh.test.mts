/**
 * Scheduled daily source refresh: per-saved-search planning, cross-search dedupe, window, claims, isolation. Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/scheduled-refresh.test.mts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { EMPTY_FILTERS, type Filters } from '../../lib/filters.ts'
import type { SavedSearch } from '../../lib/saved-searches.ts'
import type { SourceKey } from '../../lib/refresh-all.ts'
import {
  MAX_SCHEDULED_RUNS,
  isScheduledRefreshWindow,
  israelDateKey,
  planScheduledRefresh,
  runScheduledRefresh,
  stableKey,
  type ClaimResult,
  type RefreshPlan,
  type SourceRecord,
  type SourceStartResult,
} from '../../lib/scheduled-refresh.ts'

let seq = 0
function search(scope: 'rent' | 'sale', filters: Partial<Filters> = {}, id?: string): SavedSearch {
  seq++
  return {
    id: id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name: `s${seq}`,
    scope,
    filters: { ...EMPTY_FILTERS, city: 'Tel Aviv', ...filters },
    sort: 'newest',
    clientName: null,
    clientPhone: null,
    clientEmail: null,
    notes: null,
    lastCheckedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

test('two saved searches with identical criteria produce one Yad2 run and one Madlan run serving both', () => {
  const a = search('rent', { maxPrice: '8000', minRooms: '3' })
  const b = search('rent', { maxPrice: '8000', minRooms: '3' })
  const plan = planScheduledRefresh([a, b])
  assert.equal(plan.yad2.length, 1)
  assert.deepEqual(plan.yad2[0].savedSearchIds, [a.id, b.id])
  assert.equal(plan.madlan.length, 1)
  assert.deepEqual(plan.madlan[0].savedSearchIds, [a.id, b.id])
  assert.ok(plan.facebook)
})

test('min price differences do not split Yad2 (filtered locally) but do split Madlan (sent to the actor)', () => {
  const a = search('rent', { maxPrice: '8000', minPrice: '5000' })
  const b = search('rent', { maxPrice: '8000', minPrice: '6000' })
  const plan = planScheduledRefresh([a, b])
  assert.equal(plan.yad2.length, 1)
  assert.equal(plan.madlan.length, 2)
})

test('only the deal types used by saved searches are planned', () => {
  const rentOnly = planScheduledRefresh([search('rent'), search('rent', { maxPrice: '9000' })])
  assert.ok(rentOnly.yad2.every((r) => r.input.includes('/realestate/rent')))
  assert.ok(rentOnly.madlan.every((r) => r.input.dealType === 'rent'))

  const mixed = planScheduledRefresh([search('rent'), search('sale')])
  assert.equal(mixed.yad2.filter((r) => r.input.includes('/realestate/forsale')).length, 1)
  assert.equal(mixed.madlan.filter((r) => r.input.dealType === 'buy').length, 1)
})

test('overlapping Yad2 neighborhoods share the per-neighborhood URL run', () => {
  const a = search('rent', { neighborhoods: ['Florentin', 'Neve Tzedek'] })
  const b = search('rent', { neighborhoods: ['Florentin'] })
  const plan = planScheduledRefresh([a, b])
  assert.equal(plan.yad2.length, 2)
  const florentin = plan.yad2.find((r) => r.input.includes('neighborhood=205'))
  assert.deepEqual(florentin?.savedSearchIds, [a.id, b.id])
})

test('Madlan inputs dedupe regardless of key order', () => {
  assert.equal(stableKey({ b: 1, a: { d: 2, c: 3 } }), stableKey({ a: { c: 3, d: 2 }, b: 1 }))
  assert.notEqual(stableKey({ a: 1 }), stableKey({ a: 2 }))
})

test('a city the scrapers do not support is skipped for Yad2 and Madlan, with a reason', () => {
  const s = search('rent', { city: 'Haifa' })
  const plan = planScheduledRefresh([s])
  assert.equal(plan.yad2.length, 0)
  assert.equal(plan.madlan.length, 0)
  assert.deepEqual(plan.skipped.map((x) => x.source).sort(), ['madlan', 'yad2'])
  assert.ok(plan.facebook, 'Facebook still runs; it ignores filters')
})

test('too many Madlan neighborhoods fall back to one Tel Aviv-wide run instead of dropping the search', () => {
  const s = search('rent', { neighborhoods: ['Florentin', 'Neve Tzedek', 'Old North', 'New North'] })
  const plan = planScheduledRefresh([s])
  assert.equal(plan.madlan.length, 1)
  assert.equal(plan.madlan[0].input.neighbourhood, undefined)
  assert.ok(plan.notes.some((n) => n.source === 'madlan' && n.savedSearchId === s.id))
})

test('no saved searches: nothing is planned for any source', () => {
  const plan = planScheduledRefresh([])
  assert.equal(plan.yad2.length + plan.madlan.length, 0)
  assert.equal(plan.facebook, null)
})

test('per-source daily cap keeps the plan bounded and reports what was left out', () => {
  const many = Array.from({ length: MAX_SCHEDULED_RUNS.madlan + 3 }, (_, i) => search('rent', { maxPrice: String(5000 + i * 100) }))
  const plan = planScheduledRefresh(many)
  assert.equal(plan.madlan.length, MAX_SCHEDULED_RUNS.madlan)
  assert.equal(plan.capped.filter((c) => c.source === 'madlan').length, 3)
})

test('06:30 Israel window holds in summer (03:30 UTC) and winter (04:30 UTC) only', () => {
  assert.equal(isScheduledRefreshWindow(new Date('2026-07-15T03:30:00Z')), true)
  assert.equal(isScheduledRefreshWindow(new Date('2026-07-15T04:30:00Z')), false)
  assert.equal(isScheduledRefreshWindow(new Date('2026-01-15T04:30:00Z')), true)
  assert.equal(isScheduledRefreshWindow(new Date('2026-01-15T03:30:00Z')), false)
  assert.equal(israelDateKey(new Date('2026-07-15T22:30:00Z')), '2026-07-16')
})

test('vercel.json keeps the 08:00 alert crons unchanged and adds the 06:30 refresh crons', () => {
  const crons = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')).crons as { path: string; schedule: string }[]
  const by = (p: string) => crons.filter((c) => c.path === p).map((c) => c.schedule).sort()
  assert.deepEqual(by('/api/cron/saved-search-alerts'), ['0 5 * * *', '0 6 * * *'])
  assert.deepEqual(by('/api/cron/source-refresh'), ['30 3 * * *', '30 4 * * *'])
})

function harness(plan: RefreshPlan, opts: { claims?: Partial<Record<SourceKey, ClaimResult>>; start?: Partial<Record<SourceKey, () => Promise<SourceStartResult>>> } = {}) {
  const calls = { claim: [] as SourceKey[], start: [] as SourceKey[], record: [] as [SourceKey, SourceRecord][] }
  const ok = (ids: string[]) => async (): Promise<SourceStartResult> => ({ ok: true, runIds: ids, failures: [] })
  const starter = (k: SourceKey, fallback: () => Promise<SourceStartResult>) => async () => {
    calls.start.push(k)
    return (opts.start?.[k] ?? fallback)()
  }
  const deps = {
    plan,
    claim: async (s: SourceKey) => {
      calls.claim.push(s)
      return opts.claims?.[s] ?? { status: 'claimed' as const }
    },
    record: async (s: SourceKey, r: SourceRecord) => {
      calls.record.push([s, r])
    },
    start: { yad2: starter('yad2', ok(['yRun00001'])), madlan: starter('madlan', ok(['mRun00001'])), facebook: starter('facebook', ok(['fRun00001'])) },
  }
  return { calls, deps }
}

test('dry run: no claim, no start, no record', async () => {
  const { calls, deps } = harness(planScheduledRefresh([search('rent')]))
  const results = await runScheduledRefresh({ ...deps, dryRun: true })
  assert.deepEqual(calls, { claim: [], start: [], record: [] })
  assert.ok(results.every((r) => r.status === 'would-start'))
})

test('one source throwing does not block the others', async () => {
  const { calls, deps } = harness(planScheduledRefresh([search('rent')]), {
    start: { madlan: async () => { throw new Error('boom') } },
  })
  const results = await runScheduledRefresh({ ...deps, dryRun: false })
  const by = Object.fromEntries(results.map((r) => [r.source, r]))
  assert.equal(by.yad2.status, 'started')
  assert.equal(by.madlan.status, 'failed')
  assert.equal(by.facebook.status, 'started')
  assert.equal(calls.record.length, 3)
})

test('an already-claimed source is skipped without starting Apify; a claim error only affects that source', async () => {
  const { calls, deps } = harness(planScheduledRefresh([search('rent')]), {
    claims: { yad2: { status: 'already-claimed' }, madlan: { status: 'error', message: 'relation does not exist' } },
  })
  const results = await runScheduledRefresh({ ...deps, dryRun: false })
  const by = Object.fromEntries(results.map((r) => [r.source, r]))
  assert.equal(by.yad2.status, 'already-claimed')
  assert.equal(by.madlan.status, 'claim-failed')
  assert.equal(by.facebook.status, 'started')
  assert.deepEqual(calls.start, ['facebook'])
})

test('partial start is recorded as partial with the limit error', async () => {
  const { calls, deps } = harness(planScheduledRefresh([search('rent', { neighborhoods: ['Florentin', 'Bavli'] })]), {
    start: { yad2: async () => ({ ok: true, runIds: ['yRun00001'], failures: [{ key: 'u', error: 'limit', limitReached: true }] }) },
  })
  const results = await runScheduledRefresh({ ...deps, dryRun: false })
  assert.equal(results.find((r) => r.source === 'yad2')?.status, 'partial')
  const rec = calls.record.find(([s]) => s === 'yad2')?.[1]
  assert.equal(rec?.status, 'partial')
  assert.match(rec?.error ?? '', /\[limit\]/)
})

test('a source with nothing planned is not claimed', async () => {
  const { calls, deps } = harness(planScheduledRefresh([search('rent', { city: 'Haifa' })]))
  const results = await runScheduledRefresh({ ...deps, dryRun: false })
  assert.deepEqual(calls.claim, ['facebook'])
  assert.equal(results.find((r) => r.source === 'yad2')?.status, 'nothing-to-run')
})
