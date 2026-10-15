/**
 * Unified "Refresh all sources": parallel start, independent completion, partial failure, reload, de-duplication. Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/refresh-all.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_FILTERS, type Filters } from '../../lib/filters.ts'
import {
  REFRESH_SOURCES,
  buildSourceInputs,
  parseSession,
  sourceProgress,
  sourcesToStart,
  startSourcesInParallel,
  summarizeRefresh,
  terminalResult,
  type RefreshSession,
  type SourceKey,
  type SourceProgress,
  type SourceSnapshot,
  type StartOutcome,
} from '../../lib/refresh-all.ts'
import { buildSearchUrls as buildFromCriteria, validateCriteria } from '../../lib/yad2-search.ts'

function buildSearchUrls(input: { city: string; transactionType: string }) {
  const v = validateCriteria({ city: input.city, transaction_type: input.transactionType })
  assert.ok(v.ok)
  return buildFromCriteria(v.data).urls
}

const idle: SourceSnapshot = { phase: 'idle', isStarting: false }
const running: SourceSnapshot = { phase: 'running', isStarting: false }
const done: SourceSnapshot = { phase: 'done', isStarting: false }
const failed: SourceSnapshot = { phase: 'failed', isStarting: false }

const filters: Filters = {
  ...EMPTY_FILTERS,
  city: 'Tel Aviv',
  neighborhoods: ['Lev HaIr'],
  minRooms: '2',
  maxRooms: '3.5',
  minPrice: '6000',
  maxPrice: '11000',
  amenities: ['parking', 'pets', 'mamad'],
}

function freshSession(): RefreshSession {
  return { startedAt: 1, sources: [...REFRESH_SOURCES], outcomes: {} }
}

/** Mirrors the coordinator: record outcomes as hooks reach a terminal phase, then fold into one summary. */
function step(session: RefreshSession, snaps: Record<SourceKey, SourceSnapshot>) {
  for (const k of session.sources) {
    if (session.outcomes[k] || snaps[k].isStarting) continue
    const r = terminalResult(snaps[k].phase)
    if (r) session.outcomes[k] = r
  }
  const progress = Object.fromEntries(
    REFRESH_SOURCES.map((k) => [k, sourceProgress(k, session, snaps[k])]),
  ) as Record<SourceKey, SourceProgress>
  return summarizeRefresh(session, progress)
}

test('all 3 start together: every start is called before any of them resolves', async () => {
  const called: SourceKey[] = []
  const releases: Array<() => void> = []
  const pending = startSourcesInParallel(REFRESH_SOURCES, (k) => {
    called.push(k)
    return new Promise<StartOutcome>((resolve) => releases.push(() => resolve('started')))
  })
  await Promise.resolve()
  assert.deepEqual(called, ['yad2', 'madlan', 'facebook'], 'all three started without waiting on each other')
  releases.forEach((r) => r())
  assert.deepEqual(await pending, { yad2: 'started', madlan: 'started', facebook: 'started' })
})

test('a start that throws or refuses never cancels the others', async () => {
  const out = await startSourcesInParallel(REFRESH_SOURCES, async (k) => {
    if (k === 'facebook') throw new Error('network down')
    if (k === 'yad2') return 'refused'
    return 'started'
  })
  assert.deepEqual(out, { yad2: 'refused', madlan: 'started', facebook: 'refused' })
})

test('one finishes before the others: progress shows it at once, without waiting for all 3', () => {
  const s = freshSession()
  assert.equal(step(s, { yad2: running, madlan: running, facebook: running }).title, 'Refreshing sources… 0/3 complete')
  const one = step(s, { yad2: running, madlan: done, facebook: running })
  assert.equal(one.title, 'Refreshing sources… 1/3 complete')
  assert.deepEqual(one.updated, ['madlan'])
  assert.equal(one.active, true)
  // Madlan dismissing afterwards (idle) does not lose its recorded result.
  assert.equal(step(s, { yad2: done, madlan: idle, facebook: running }).title, 'Refreshing sources… 2/3 complete')
  const all = step(s, { yad2: idle, madlan: idle, facebook: done })
  assert.equal(all.title, 'Sources updated')
  assert.equal(all.active, false)
  assert.equal(all.detail, null)
})

test('one fails: the others still count as updated and the failure is named', () => {
  const s = freshSession()
  const mid = step(s, { yad2: running, madlan: done, facebook: failed })
  assert.equal(mid.title, 'Refreshing sources… 2/3 complete')
  assert.equal(mid.detail, 'Facebook refresh failed')
  const end = step(s, { yad2: done, madlan: done, facebook: failed })
  assert.equal(end.title, '2 of 3 sources updated')
  assert.equal(end.detail, 'Facebook refresh failed')
  assert.deepEqual(end.updated, ['yad2', 'madlan'])
})

test('a refused start is recorded as failed for that source only', () => {
  const s = freshSession()
  s.outcomes.yad2 = 'failed'
  const end = step(s, { yad2: idle, madlan: done, facebook: done })
  assert.equal(end.title, '2 of 3 sources updated')
  assert.equal(end.detail, 'Yad2 refresh failed')
})

test('a source still launching is pending even if its hook shows the previous run as done', () => {
  const s = freshSession()
  const sum = step(s, { yad2: { phase: 'done', isStarting: true }, madlan: running, facebook: running })
  assert.equal(sum.complete, 0)
  assert.equal(s.outcomes.yad2, undefined)
})

test('reload during an active refresh restores the same session and keeps counting', () => {
  const s = freshSession()
  step(s, { yad2: running, madlan: done, facebook: running })
  const restored = parseSession(JSON.stringify(s))
  assert.ok(restored)
  assert.deepEqual(restored.outcomes, { madlan: 'updated' })
  // After reload each hook resumes its own run from its own storage key; restored phases are busy again.
  const after = step(restored, { yad2: running, madlan: idle, facebook: { phase: 'background', isStarting: false } })
  assert.equal(after.title, 'Refreshing sources… 1/3 complete')
  assert.equal(step(restored, { yad2: done, madlan: idle, facebook: done }).title, 'Sources updated')
})

test('a corrupt or empty stored session is ignored', () => {
  assert.equal(parseSession(null), null)
  assert.equal(parseSession('{not json'), null)
  assert.equal(parseSession(JSON.stringify({ startedAt: 1, sources: ['unknown'] })), null)
  assert.deepEqual(parseSession(JSON.stringify({ startedAt: 1, sources: ['yad2'], outcomes: { yad2: 'bogus' } })), {
    startedAt: 1,
    sources: ['yad2'],
    outcomes: {},
  })
})

test('an active run is attached to, not started again', () => {
  assert.deepEqual(sourcesToStart({ yad2: running, madlan: idle, facebook: done }), ['madlan', 'facebook'])
  assert.deepEqual(
    sourcesToStart({ yad2: { phase: 'importing', isStarting: false }, madlan: { phase: 'idle', isStarting: true }, facebook: failed }),
    ['facebook'],
  )
})

test('second click while running starts nothing new', () => {
  const allBusy = { yad2: running, madlan: { phase: 'background', isStarting: false }, facebook: { phase: 'idle', isStarting: true } }
  assert.deepEqual(sourcesToStart(allBusy), [])
  const s = freshSession()
  assert.equal(step(s, allBusy).active, true, 'session stays active, so the button stays disabled')
})

test('Rent refresh: Yad2 and Madlan both use rent, Yad2 URL is /realestate/rent', () => {
  const { yad2, madlan } = buildSourceInputs(filters, 'rent')
  assert.equal(yad2.transactionType, 'rent')
  assert.equal(madlan.transactionType, 'rent')
  for (const url of buildSearchUrls(yad2)) assert.match(url, /\/realestate\/rent\?/)
})

test('Sale refresh: Yad2 and Madlan both use sale, Yad2 URL is /realestate/forsale', () => {
  const { yad2, madlan } = buildSourceInputs(filters, 'sale')
  assert.equal(yad2.transactionType, 'sale')
  assert.equal(madlan.transactionType, 'sale')
  for (const url of buildSearchUrls(yad2)) assert.match(url, /\/realestate\/forsale\?/)
})

test('"All" scope refreshes rent, as before', () => {
  assert.equal(buildSourceInputs(filters, 'all').yad2.transactionType, 'rent')
})

test('filters remain active: inputs are copied from the filters, which are left unchanged', () => {
  const before = JSON.stringify(filters)
  const { yad2, madlan } = buildSourceInputs(filters, 'rent')
  assert.equal(JSON.stringify(filters), before)
  assert.deepEqual(
    [yad2.city, yad2.minRooms, yad2.maxRooms, yad2.minPrice, yad2.maxPrice, yad2.neighborhoods],
    ['Tel Aviv', '2', '3.5', '6000', '11000', ['Lev HaIr']],
  )
  assert.deepEqual(madlan.amenities, ['parking', 'mamad'], 'only amenities Madlan can filter server-side')
  yad2.neighborhoods.push('Florentin')
  assert.deepEqual(filters.neighborhoods, ['Lev HaIr'], 'mutating an input never touches the filters')
})

test('listings remain visible: refresh state never touches the listing list', async () => {
  const listings = [{ id: 'a' }, { id: 'b' }]
  const snapshot = JSON.stringify(listings)
  await startSourcesInParallel(REFRESH_SOURCES, async () => 'started')
  const s = freshSession()
  step(s, { yad2: running, madlan: done, facebook: failed })
  assert.equal(JSON.stringify(listings), snapshot)
})

test('Supabase refetch happens after each individual source completes, not after all three', async () => {
  const refetches: SourceKey[] = []
  const finish: Partial<Record<SourceKey, () => void>> = {}
  // Each source behaves like its own hook: when its run completes it refetches on its own.
  await startSourcesInParallel(REFRESH_SOURCES, async (k) => {
    finish[k] = () => refetches.push(k)
    return 'started'
  })
  const s = freshSession()
  finish.madlan!()
  assert.deepEqual(refetches, ['madlan'])
  assert.equal(step(s, { yad2: running, madlan: done, facebook: running }).complete, 1)
  finish.yad2!()
  assert.deepEqual(refetches, ['madlan', 'yad2'])
  assert.equal(step(s, { yad2: done, madlan: idle, facebook: running }).active, true, 'Facebook still running')
})
