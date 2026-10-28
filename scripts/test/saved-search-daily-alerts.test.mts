/**
 * Daily saved-search alert run: batching, dedupe, failure isolation, schedule window, cron auth. Offline, no real email.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/saved-search-daily-alerts.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMENITY_KEYS, type AmenityKey, type Listing, type Source, type TriState } from '../../lib/listings.ts'
import { EMPTY_FILTERS, type Filters } from '../../lib/filters.ts'
import { dedupeAcrossSources } from '../../lib/cross-source-dedupe.ts'
import { resolveCardFirstSeen, type SavedSearch } from '../../lib/saved-searches.ts'
import { isDailyAlertWindow, israelHour, runDailyAlerts, type AlertEmail, type AlertRow } from '../../lib/saved-search-alerts.ts'
import { isAuthorizedCronRequest } from '../../lib/cron-auth.ts'

function features(overrides: Partial<Record<AmenityKey, TriState>> = {}): Record<AmenityKey, TriState> {
  const all = Object.fromEntries(AMENITY_KEYS.map((k) => [k, 'unknown'])) as Record<AmenityKey, TriState>
  return { ...all, ...overrides }
}

let seq = 0
function listing(source: Source, overrides: Partial<Listing> = {}): Listing {
  const f = overrides.features ?? features()
  seq++
  return {
    id: `${source}-${seq}`,
    title: 'Apartment',
    description: '',
    dealType: 'rent',
    price: 9_000,
    city: 'Tel Aviv',
    neighborhood: 'Old North',
    street: `דיזנגוף ${100 + seq}`,
    rooms: 3,
    surface: 75,
    floor: 2,
    propertyType: 'Apartment',
    amenities: AMENITY_KEYS.filter((k) => f[k] === 'yes'),
    features: f,
    protectedSpaceType: null,
    entryDate: null,
    known: { price: true, rooms: true, surface: true },
    phone: '',
    source,
    url: `https://example.com/${source}/${seq}`,
    publishedAt: null,
    publishedMinutesAgo: 60,
    firstSeenAt: '2026-10-15T10:00:00.000Z',
    photos: [],
    image: null,
    ...overrides,
  }
}

const LAST_CHECKED = '2026-10-10T00:00:00.000Z'
function search(id: string, filters: Partial<Filters> = {}, extra: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id,
    name: `Search ${id.slice(-1)}`,
    scope: 'rent',
    filters: { ...EMPTY_FILTERS, city: 'Tel Aviv', ...filters },
    sort: 'newest',
    clientName: 'Monique',
    clientPhone: null,
    clientEmail: `client${id.slice(-1)}@example.com`,
    notes: null,
    lastCheckedAt: LAST_CHECKED,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  }
}
const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

function harness(opts: { failSendTo?: string; recordFails?: boolean; sendThrowsFor?: string } = {}) {
  const sent: AlertEmail[] = []
  const table: AlertRow[] = []
  return {
    sent,
    table,
    alertedBySearch: () => {
      const m = new Map<string, Set<string>>()
      for (const r of table) (m.get(r.saved_search_id) ?? m.set(r.saved_search_id, new Set()).get(r.saved_search_id)!).add(r.listing_id)
      return m
    },
    send: async (email: AlertEmail) => {
      if (email.to === opts.sendThrowsFor) throw new Error('network exploded')
      if (email.to === opts.failSendTo) return { ok: false as const, message: 'provider down' }
      sent.push(email)
      return { ok: true as const }
    },
    record: async (rows: AlertRow[]) => {
      if (opts.recordFails) return { ok: false as const, message: 'db down' }
      for (const r of rows) if (!table.some((t) => t.saved_search_id === r.saved_search_id && t.listing_id === r.listing_id)) table.push(r)
      return { ok: true as const }
    },
  }
}

const run = (h: ReturnType<typeof harness>, searches: SavedSearch[], cards: Listing[], dryRun = false) =>
  runDailyAlerts({ searches, cards, alertedIdsBySearch: h.alertedBySearch(), send: h.send, record: h.record, dryRun })

test('saved search without email: skipped, nothing sent', async () => {
  const h = harness()
  const res = await run(h, [search(A, {}, { clientEmail: null })], [listing('yad2')])
  assert.deepEqual(res, [{ searchId: A, status: 'skipped-no-email', itemCount: 0 }])
  assert.equal(h.sent.length, 0)
  assert.equal(h.table.length, 0)
})

test('no new matches: nothing sent (no "no new listings" email)', async () => {
  const h = harness()
  const old = listing('yad2', { firstSeenAt: '2026-10-01T00:00:00.000Z' })
  const otherCity = listing('yad2', { city: 'Haifa' })
  const res = await run(h, [search(A)], [old, otherCity])
  assert.equal(res[0].status, 'skipped-no-new')
  assert.equal(h.sent.length, 0)
})

test('one new match: one email, one alert row', async () => {
  const h = harness()
  const card = listing('yad2')
  const res = await run(h, [search(A)], [card])
  assert.deepEqual(res, [{ searchId: A, status: 'sent', itemCount: 1 }])
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.table.map((r) => r.listing_id), [card.id])
})

test('multiple new matches: ONE batched email per saved search', async () => {
  const h = harness()
  const cards = [listing('yad2'), listing('madlan'), listing('facebook'), listing('yad2')]
  const res = await run(h, [search(A)], cards)
  assert.equal(h.sent.length, 1)
  assert.equal(res[0].itemCount, 4)
  assert.match(h.sent[0].subject, /^4 new rental listings/)
  assert.equal(new Set(h.table.map((r) => r.batch_id)).size, 1)
})

test('cross-source merged duplicate counts once', async () => {
  const h = harness()
  const yad2 = listing('yad2', { street: 'הירקון 50', rooms: 3, surface: 80, price: 10_000, floor: 3 })
  const madlan = listing('madlan', { street: 'הירקון 50', rooms: 3, surface: 80, price: 10_000, floor: 3 })
  const cards = resolveCardFirstSeen(dedupeAcrossSources([yad2, madlan]), [yad2, madlan])
  assert.equal(cards.length, 1, 'fixture must merge into one card')
  const res = await run(h, [search(A)], cards)
  assert.equal(res[0].itemCount, 1)
  assert.equal(h.sent.length, 1)
  assert.deepEqual(new Set(h.table.map((r) => r.listing_id)), new Set([yad2.id, madlan.id]))
})

test('already alerted listing is skipped on the next daily run', async () => {
  const h = harness()
  const first = listing('yad2')
  await run(h, [search(A)], [first])
  assert.equal(h.sent.length, 1)

  const again = await run(h, [search(A)], [first])
  assert.equal(again[0].status, 'skipped-no-new')
  assert.equal(h.sent.length, 1)

  const second = listing('madlan')
  const next = await run(h, [search(A)], [first, second])
  assert.equal(next[0].itemCount, 1)
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].itemCount, 1)
})

test('successful send records alerts for exactly the emailed cards', async () => {
  const h = harness()
  const cards = [listing('yad2'), listing('madlan')]
  await run(h, [search(A)], cards)
  assert.deepEqual(h.table.map((r) => r.listing_id).sort(), cards.map((c) => c.id).sort())
  assert.ok(h.table.every((r) => r.saved_search_id === A && r.channel === 'email'))
})

test('failed send records nothing, and the next run retries', async () => {
  const s = search(A)
  const h = harness({ failSendTo: s.clientEmail! })
  const card = listing('yad2')
  const res = await run(h, [s], [card])
  assert.equal(res[0].status, 'send-failed')
  assert.equal(h.table.length, 0)

  const retry = harness()
  const ok = await run(retry, [s], [card])
  assert.equal(ok[0].status, 'sent')
})

test('send succeeds but recording fails: reported as sent-not-recorded, not success', async () => {
  const h = harness({ recordFails: true })
  const res = await run(h, [search(A)], [listing('yad2')])
  assert.equal(res[0].status, 'sent-not-recorded')
  assert.equal(res[0].message, 'db down')
})

test('recording that throws is still reported as sent-not-recorded', async () => {
  const h = harness()
  const res = await runDailyAlerts({
    searches: [search(A)],
    cards: [listing('yad2')],
    alertedIdsBySearch: new Map(),
    send: h.send,
    record: async () => {
      throw new Error('connection reset')
    },
  })
  assert.equal(res[0].status, 'sent-not-recorded')
})

test('one search failure does not block another', async () => {
  const a = search(A)
  const b = search(B)
  const h = harness({ sendThrowsFor: a.clientEmail! })
  const res = await run(h, [a, b], [listing('yad2')])
  assert.deepEqual(res.map((r) => r.status), ['send-failed', 'sent'])
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].to, b.clientEmail)
  assert.ok(h.table.every((r) => r.saved_search_id === B))
})

test('last_checked_at remains unchanged', async () => {
  const s = search(A)
  const before = structuredClone(s)
  const h = harness()
  await run(h, [s], [listing('yad2')])
  assert.equal(s.lastCheckedAt, LAST_CHECKED)
  assert.deepEqual(s, before)
  assert.ok(h.table.every((r) => !('last_checked_at' in r)))
})

test('dry run sends nothing and records nothing', async () => {
  const h = harness()
  const res = await run(h, [search(A), search(B, {}, { clientEmail: null })], [listing('yad2')], true)
  assert.deepEqual(res.map((r) => r.status), ['would-send', 'skipped-no-email'])
  assert.equal(h.sent.length, 0)
  assert.equal(h.table.length, 0)
})

test('results never contain client name, email or listing content', async () => {
  const h = harness()
  const res = await run(h, [search(A)], [listing('yad2')])
  const serialized = JSON.stringify(res)
  assert.doesNotMatch(serialized, /@example\.com|Monique|example\.com\/yad2/)
})

test('Israel 08:00 window is DST-aware for both UTC cron slots', () => {
  // Winter (IST, UTC+2): 06:00 UTC is 08:00 in Israel, 05:00 UTC is 07:00.
  assert.equal(israelHour(new Date('2026-12-15T06:00:00Z')), 8)
  assert.equal(isDailyAlertWindow(new Date('2026-12-15T06:30:00Z')), true)
  assert.equal(isDailyAlertWindow(new Date('2026-12-15T05:59:59Z')), false)
  // Summer (IDT, UTC+3): 05:00 UTC is 08:00 in Israel, 06:00 UTC is 09:00.
  assert.equal(israelHour(new Date('2026-07-15T05:00:00Z')), 8)
  assert.equal(isDailyAlertWindow(new Date('2026-07-15T05:45:00Z')), true)
  assert.equal(isDailyAlertWindow(new Date('2026-07-15T06:00:00Z')), false)
})

test('exactly one of the two UTC slots fires per day, all year', () => {
  for (let d = 0; d < 366; d++) {
    const day = new Date(Date.UTC(2026, 0, 1 + d))
    const at = (h: number) => new Date(day.getTime() + h * 3_600_000)
    const fired = [5, 6].filter((h) => isDailyAlertWindow(at(h)))
    assert.equal(fired.length, 1, `day ${day.toISOString().slice(0, 10)} fired ${fired.length} times`)
  }
})

test('unauthorized cron requests are rejected', () => {
  const secret = 'a-long-random-cron-secret-value'
  assert.equal(isAuthorizedCronRequest(null, secret), false)
  assert.equal(isAuthorizedCronRequest('', secret), false)
  assert.equal(isAuthorizedCronRequest(secret, secret), false, 'missing Bearer prefix')
  assert.equal(isAuthorizedCronRequest('Bearer wrong', secret), false)
  assert.equal(isAuthorizedCronRequest(`Basic ${secret}`, secret), false)
  assert.equal(isAuthorizedCronRequest(`Bearer ${secret}`, undefined), false, 'no CRON_SECRET configured')
  assert.equal(isAuthorizedCronRequest('Bearer short', 'short'), false, 'secret too short')
  assert.equal(isAuthorizedCronRequest(`Bearer ${secret}`, secret), true)
})
