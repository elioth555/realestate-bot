/**
 * Saved-search email alerts: eligibility, dedupe, merged cards, send/record ordering, email content. Offline.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/saved-search-alerts.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AMENITY_KEYS, type AmenityKey, type Listing, type Source, type TriState } from '../../lib/listings.ts'
import { EMPTY_FILTERS, type Filters } from '../../lib/filters.ts'
import { dedupeAcrossSources } from '../../lib/cross-source-dedupe.ts'
import { resolveCardFirstSeen, summarizeSavedSearch, type SavedSearch } from '../../lib/saved-searches.ts'
import {
  MAX_ALERT_ITEMS,
  alertEligibility,
  alertIdempotencyKey,
  alertRowsFor,
  buildAlertEmail,
  pendingAlertCards,
  runAlertSend,
  type AlertRow,
} from '../../lib/saved-search-alerts.ts'

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

function search(filters: Partial<Filters> = {}, extra: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Monique - rent',
    scope: 'rent',
    filters: { ...EMPTY_FILTERS, city: 'Tel Aviv', ...filters },
    sort: 'newest',
    clientName: 'Monique',
    clientPhone: '050-0000000',
    clientEmail: 'monique@example.com',
    notes: 'internal note: budget flexible',
    lastCheckedAt: '2026-10-10T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  }
}

const none = new Set<string>()

/** In-memory send + record, mimicking the provider and the saved_search_alerts table. */
function harness(opts: { sendFails?: boolean; recordFails?: boolean } = {}) {
  const sent: { to: string; key: string }[] = []
  const table: AlertRow[] = []
  return {
    sent,
    table,
    alerted: () => new Set(table.map((r) => r.listing_id)),
    send: async (email: { to: string }, key: string) => {
      if (opts.sendFails) return { ok: false as const, message: 'provider down' }
      sent.push({ to: email.to, key })
      return { ok: true as const }
    },
    record: async (rows: AlertRow[]) => {
      if (opts.recordFails) return { ok: false as const, message: 'db down' }
      for (const r of rows) if (!table.some((t) => t.saved_search_id === r.saved_search_id && t.listing_id === r.listing_id)) table.push(r)
      return { ok: true as const }
    },
  }
}

test('no email address: not eligible, nothing sent', async () => {
  const s = search({}, { clientEmail: null })
  const cards = [listing('yad2')]
  assert.deepEqual(alertEligibility(s, pendingAlertCards(cards, s, none)), { ok: false, reason: 'no-email' })
  const h = harness()
  const out = await runAlertSend({ search: s, cards, alertedIds: none, send: h.send, record: h.record })
  assert.deepEqual(out, { status: 'ineligible', reason: 'no-email' })
  assert.equal(h.sent.length, 0)
})

test('no new matches: not eligible', () => {
  const s = search()
  const old = [listing('yad2', { firstSeenAt: '2026-10-01T00:00:00.000Z' })]
  assert.deepEqual(alertEligibility(s, pendingAlertCards(old, s, none)), { ok: false, reason: 'no-new' })
})

test('new matches use exactly the saved-search "new" rule and count', () => {
  const s = search({ neighborhoods: ['Old North'] })
  const cards = [
    listing('yad2'),
    listing('madlan', { neighborhood: 'Florentin' }),
    listing('yad2', { firstSeenAt: '2026-10-01T00:00:00.000Z' }),
    listing('yad2', { dealType: 'sale', price: 3_000_000 }),
  ]
  const pending = pendingAlertCards(cards, s, none)
  assert.equal(pending.length, summarizeSavedSearch(cards, s).newMatches)
  assert.deepEqual(pending.map((c) => c.id), [cards[0].id])
})

test('sending once records the cards; a second send is blocked (no duplicates)', async () => {
  const s = search()
  const cards = [listing('yad2'), listing('madlan')]
  const h = harness()
  const first = await runAlertSend({ search: s, cards, alertedIds: h.alerted(), send: h.send, record: h.record })
  assert.equal(first.status, 'sent')
  assert.equal(h.table.length, 2)
  const second = await runAlertSend({ search: s, cards, alertedIds: h.alerted(), send: h.send, record: h.record })
  assert.deepEqual(second, { status: 'ineligible', reason: 'no-new' })
  assert.equal(h.sent.length, 1)
})

test('only not-yet-alerted listings go into the next email', async () => {
  const s = search()
  const a = listing('yad2')
  const h = harness()
  await runAlertSend({ search: s, cards: [a], alertedIds: h.alerted(), send: h.send, record: h.record })
  const b = listing('madlan')
  const out = await runAlertSend({ search: s, cards: [a, b], alertedIds: h.alerted(), send: h.send, record: h.record })
  assert.equal(out.status, 'sent')
  assert.equal(out.status === 'sent' && out.email.itemCount, 1)
  assert.deepEqual(h.table.map((r) => r.listing_id).sort(), [a.id, b.id].sort())
})

test('failed send records nothing and can be retried', async () => {
  const s = search()
  const cards = [listing('yad2')]
  const broken = harness({ sendFails: true })
  const out = await runAlertSend({ search: s, cards, alertedIds: broken.alerted(), send: broken.send, record: broken.record })
  assert.equal(out.status, 'send-failed')
  assert.equal(broken.table.length, 0)
  assert.equal(pendingAlertCards(cards, s, broken.alerted()).length, 1)
})

test('a thrown provider error is treated as a failed send', async () => {
  const h = harness()
  const out = await runAlertSend({
    search: search(),
    cards: [listing('yad2')],
    alertedIds: none,
    send: async () => {
      throw new Error('network')
    },
    record: h.record,
  })
  assert.equal(out.status, 'send-failed')
  assert.equal(h.table.length, 0)
})

test('sent but recording failed is reported, never silently "sent"', async () => {
  const h = harness({ recordFails: true })
  const out = await runAlertSend({ search: search(), cards: [listing('yad2')], alertedIds: none, send: h.send, record: h.record })
  assert.equal(out.status, 'sent-not-recorded')
})

test('cross-source merged card is one alert item, stays alerted via any member', async () => {
  const y2 = listing('yad2', { street: 'דיזנגוף 50' })
  const md = listing('madlan', { street: 'דיזנגוף 50', photos: ['a', 'b', 'c'] })
  const merged = resolveCardFirstSeen(dedupeAcrossSources([y2, md]), [y2, md])
  assert.equal(merged.length, 1)
  const s = search()
  const h = harness()
  const out = await runAlertSend({ search: s, cards: merged, alertedIds: h.alerted(), send: h.send, record: h.record })
  assert.equal(out.status === 'sent' && out.email.itemCount, 1)
  assert.deepEqual(h.table.map((r) => r.listing_id).sort(), [y2.id, md.id].sort())
  assert.ok(h.table.every((r) => r.card_listing_id === merged[0].id))
  // Only one member remains visible (representative changed): still counts as alerted.
  assert.equal(pendingAlertCards([y2], s, h.alerted()).length, 0)
  assert.equal(pendingAlertCards([md], s, h.alerted()).length, 0)
})

test('sending never changes last_checked_at or the "N new" badge', async () => {
  const s = search()
  const before = JSON.stringify(s)
  const cards = [listing('yad2')]
  const h = harness()
  await runAlertSend({ search: s, cards, alertedIds: none, send: h.send, record: h.record })
  assert.equal(JSON.stringify(s), before)
  assert.equal(summarizeSavedSearch(cards, s).newMatches, 1)
})

test('idempotency key is stable for the same cards, regardless of order', () => {
  const a = listing('yad2')
  const b = listing('madlan')
  assert.equal(alertIdempotencyKey('s1', [a, b]), alertIdempotencyKey('s1', [b, a]))
  assert.notEqual(alertIdempotencyKey('s1', [a]), alertIdempotencyKey('s1', [a, b]))
})

test('rows are only for the cards that were sent', () => {
  const a = listing('yad2')
  const rows = alertRowsFor('s1', [a], '2026-10-28T00:00:00.000Z', 'batch')
  assert.deepEqual(rows, [{ saved_search_id: 's1', listing_id: a.id, card_listing_id: a.id, channel: 'email', sent_at: '2026-10-28T00:00:00.000Z', batch_id: 'batch' }])
})

test('email content: client-facing details, no internal data, HTML escaped', () => {
  const s = search()
  const card = listing('yad2', {
    price: 9_500,
    street: '<script>x</script>',
    image: 'https://cdn.example.com/p.jpg',
    features: features({ mamad: 'yes', parking: 'yes' }),
  })
  const email = buildAlertEmail(s, [card])
  assert.equal(email.to, 'monique@example.com')
  assert.equal(email.subject, '1 new rental listing for Monique')
  assert.match(email.text, /Hello Monique,/)
  assert.match(email.text, /₪9,500 \/ month/)
  assert.match(email.text, /3 rooms · 75 m²/)
  assert.match(email.text, new RegExp(card.url.replace(/[/.]/g, '\\$&')))
  assert.ok(email.html.includes('https://cdn.example.com/p.jpg'))
  assert.ok(!email.html.includes('<script>x</script>'))
  for (const secret of [s.id, card.id, s.notes!, s.clientPhone!]) {
    assert.ok(!email.text.includes(secret), `text leaks ${secret}`)
    assert.ok(!email.html.includes(secret), `html leaks ${secret}`)
  }
})

test('unknown price and non-http links are handled', () => {
  const card = listing('facebook', { known: { price: false, rooms: true, surface: false }, url: 'javascript:alert(1)' })
  const email = buildAlertEmail(search(), [card])
  assert.match(email.text, /Price on request/)
  assert.ok(!email.html.includes('javascript:'))
})

test('long batches are capped and summarized', () => {
  const many = Array.from({ length: MAX_ALERT_ITEMS + 3 }, () => listing('yad2'))
  const email = buildAlertEmail(search(), many)
  assert.equal(email.itemCount, MAX_ALERT_ITEMS + 3)
  assert.equal(email.omitted, 3)
  assert.match(email.text, /And 3 more listings\./)
})
