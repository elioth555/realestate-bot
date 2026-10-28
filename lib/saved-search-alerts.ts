import { amenityDisplayLabel, listingLinks, type Listing } from './listings'
import { cardMemberIds, isNewSince, savedSearchMatches, type SavedSearch } from './saved-searches'

export const ALERT_CHANNEL = 'email' as const
export const MAX_ALERT_ITEMS = 25

/** One stored row per source listing behind an alerted card, so a merged card stays alerted if its representative changes. */
export type AlertRow = {
  saved_search_id: string
  listing_id: string
  card_listing_id: string
  channel: typeof ALERT_CHANNEL
  sent_at: string
  batch_id: string
}

/** A card was already alerted when any of its member source listings was. */
export function isAlerted(card: Listing, alertedIds: ReadonlySet<string>): boolean {
  return cardMemberIds(card).some((id) => alertedIds.has(id))
}

/** New matching cards (same rule as the "N new" badge) that have not been emailed for this search. */
export function pendingAlertCards(cards: Listing[], search: SavedSearch, alertedIds: ReadonlySet<string>): Listing[] {
  const unique = [...new Map(savedSearchMatches(cards, search).map((c) => [c.id, c])).values()]
  return unique
    .filter((c) => isNewSince(c, search.lastCheckedAt) && !isAlerted(c, alertedIds))
    .sort((a, b) => (b.firstSeenAt ?? '').localeCompare(a.firstSeenAt ?? ''))
}

export type Ineligible = 'no-email' | 'no-new'

export function alertEligibility(search: Pick<SavedSearch, 'clientEmail'>, pending: Listing[]): { ok: true } | { ok: false; reason: Ineligible } {
  if (!search.clientEmail?.trim()) return { ok: false, reason: 'no-email' }
  if (pending.length === 0) return { ok: false, reason: 'no-new' }
  return { ok: true }
}

export const INELIGIBLE_MESSAGES: Record<Ineligible, string> = {
  'no-email': 'Add a client email address before sending an alert.',
  'no-new': 'There are no new matching listings that have not already been emailed.',
}

export type AlertEmail = { to: string; subject: string; text: string; html: string; itemCount: number; omitted: number }

const money = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function priceLabel(card: Listing) {
  if (!card.known.price || card.price <= 0) return 'Price on request'
  return `₪${money.format(card.price)}${card.dealType === 'rent' ? ' / month' : ''}`
}

function addressLabel(card: Listing) {
  return [card.street, card.neighborhood, card.city].map((p) => p?.trim()).filter(Boolean).join(', ')
}

function specsLabel(card: Listing) {
  const parts: string[] = []
  if (card.known.rooms && card.rooms > 0) parts.push(`${card.rooms} rooms`)
  if (card.known.surface && card.surface > 0) parts.push(`${card.surface} m²`)
  return parts.join(' · ')
}

function amenitiesLabel(card: Listing) {
  return card.amenities.slice(0, 5).map((key) => amenityDisplayLabel(card, key)).join(', ')
}

function safeHttpUrl(url: string | null | undefined) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function linkFor(card: Listing) {
  return safeHttpUrl(card.url) ?? listingLinks(card).map((l) => safeHttpUrl(l.url)).find(Boolean) ?? null
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Builds the exact email that would be sent. Contains no internal ids. */
export function buildAlertEmail(search: SavedSearch, pending: Listing[]): AlertEmail {
  const items = pending.slice(0, MAX_ALERT_ITEMS)
  const omitted = pending.length - items.length
  const count = pending.length
  const deal = search.scope === 'rent' ? 'rental' : 'for-sale'
  const who = search.clientName?.trim() || search.name
  const subject = `${count} new ${deal} ${count === 1 ? 'listing' : 'listings'} for ${who}`
  const greeting = search.clientName?.trim() ? `Hello ${search.clientName.trim()},` : 'Hello,'
  const intro = `${count} new ${count === 1 ? 'listing matches' : 'listings match'} your search "${search.name}".`

  const rows = items.map((card) => ({
    deal: card.dealType === 'rent' ? 'Rent' : 'Sale',
    price: priceLabel(card),
    address: addressLabel(card),
    specs: specsLabel(card),
    amenities: amenitiesLabel(card),
    image: safeHttpUrl(card.image),
    link: linkFor(card),
  }))
  const more = omitted > 0 ? `And ${omitted} more ${omitted === 1 ? 'listing' : 'listings'}.` : ''

  const text = [
    greeting,
    '',
    intro,
    '',
    ...rows.flatMap((r, i) => [
      `${i + 1}. ${r.deal} · ${r.price}`,
      ...[r.address, r.specs, r.amenities].filter(Boolean).map((line) => `   ${line}`),
      ...(r.link ? [`   ${r.link}`] : []),
      '',
    ]),
    ...(more ? [more, ''] : []),
    'Reply to this email if you would like to arrange a viewing.',
  ].join('\n')

  const cell = 'font-family:Arial,Helvetica,sans-serif;color:#1f2933;'
  const htmlRows = rows
    .map(
      (r) => `<tr><td style="padding:12px 0;border-top:1px solid #e4e7eb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${r.image ? `<td width="120" valign="top" style="padding-right:12px;"><img src="${escapeHtml(r.image)}" width="120" height="90" alt="" style="display:block;width:120px;height:90px;object-fit:cover;border-radius:6px;"></td>` : ''}
<td valign="top" style="${cell}font-size:14px;line-height:1.5;">
<div style="font-size:12px;color:#616e7c;">${escapeHtml(r.deal)}</div>
<div style="font-size:16px;font-weight:bold;">${escapeHtml(r.price)}</div>
${r.address ? `<div>${escapeHtml(r.address)}</div>` : ''}
${r.specs ? `<div style="color:#3e4c59;">${escapeHtml(r.specs)}</div>` : ''}
${r.amenities ? `<div style="color:#616e7c;font-size:13px;">${escapeHtml(r.amenities)}</div>` : ''}
${r.link ? `<div style="margin-top:4px;"><a href="${escapeHtml(r.link)}" style="color:#1d4ed8;">View listing</a></div>` : ''}
</td></tr></table></td></tr>`,
    )
    .join('\n')

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f7fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">
<tr><td style="${cell}font-size:14px;line-height:1.5;">
<p style="margin:0 0 8px;">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
</td></tr>
${htmlRows}
${more ? `<tr><td style="${cell}font-size:14px;padding-top:12px;">${escapeHtml(more)}</td></tr>` : ''}
<tr><td style="${cell}font-size:13px;color:#616e7c;padding-top:16px;border-top:1px solid #e4e7eb;">Reply to this email if you would like to arrange a viewing.</td></tr>
</table></body></html>`

  return { to: (search.clientEmail ?? '').trim(), subject, text, html, itemCount: count, omitted }
}

/** Rows to insert after a successful send: every member id of exactly the cards that were emailed. */
export function alertRowsFor(searchId: string, sentCards: Listing[], sentAt: string, batchId: string): AlertRow[] {
  const rows = new Map<string, AlertRow>()
  for (const card of sentCards) {
    for (const listingId of cardMemberIds(card)) {
      rows.set(listingId, { saved_search_id: searchId, listing_id: listingId, card_listing_id: card.id, channel: ALERT_CHANNEL, sent_at: sentAt, batch_id: batchId })
    }
  }
  return [...rows.values()]
}

/** Stable for the same search and the same set of cards, so a double click cannot send twice (provider idempotency). */
export function alertIdempotencyKey(searchId: string, cards: Listing[]) {
  return `saved-search-alert:${searchId}:${cards.map((c) => c.id).sort().join(',')}`.slice(0, 256)
}

export type SendResult = { ok: true } | { ok: false; message: string; notConfigured?: boolean }

export type AlertOutcome =
  | { status: 'sent'; email: AlertEmail; recordedCards: number }
  | { status: 'ineligible'; reason: Ineligible }
  | { status: 'send-failed'; message: string; notConfigured?: boolean }
  | { status: 'sent-not-recorded'; email: AlertEmail; message: string }

/**
 * Send, then record. Recording happens only after the provider accepts the email, and only for the cards in it.
 * It never touches last_checked_at: opening the search is the only thing that marks it checked.
 */
export async function runAlertSend(deps: {
  search: SavedSearch
  cards: Listing[]
  alertedIds: ReadonlySet<string>
  send: (email: AlertEmail, idempotencyKey: string) => Promise<SendResult>
  record: (rows: AlertRow[]) => Promise<{ ok: true } | { ok: false; message: string }>
  now?: () => Date
  newBatchId?: () => string
}): Promise<AlertOutcome> {
  const pending = pendingAlertCards(deps.cards, deps.search, deps.alertedIds)
  const eligible = alertEligibility(deps.search, pending)
  if (!eligible.ok) return { status: 'ineligible', reason: eligible.reason }

  const email = buildAlertEmail(deps.search, pending)
  let sent: SendResult
  try {
    sent = await deps.send(email, alertIdempotencyKey(deps.search.id, pending))
  } catch (error) {
    sent = { ok: false, message: error instanceof Error ? error.message : 'Email provider error.' }
  }
  if (!sent.ok) return { status: 'send-failed', message: sent.message, notConfigured: sent.notConfigured }

  const rows = alertRowsFor(deps.search.id, pending, (deps.now?.() ?? new Date()).toISOString(), deps.newBatchId?.() ?? crypto.randomUUID())
  const recorded = await deps.record(rows)
  if (!recorded.ok) return { status: 'sent-not-recorded', email, message: recorded.message }
  return { status: 'sent', email, recordedCards: pending.length }
}

export const DAILY_ALERT_TIMEZONE = 'Asia/Jerusalem'
export const DAILY_ALERT_HOUR = 8

/** Hour of day (0-23) in Israel, DST-aware. Vercel cron runs in UTC, so the endpoint gates on this. */
export function israelHour(now: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: DAILY_ALERT_TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(now)
  return Number(hour)
}

export const isDailyAlertWindow = (now: Date) => israelHour(now) === DAILY_ALERT_HOUR

export type DailyStatus = 'sent' | 'would-send' | 'skipped-no-email' | 'skipped-no-new' | 'send-failed' | 'sent-not-recorded' | 'error'
/** No client name, email or listing content: safe to log and return from the cron endpoint. */
export type DailyResult = { searchId: string; status: DailyStatus; itemCount: number; message?: string }

/**
 * One email per saved search, sequentially, each isolated so one failure cannot block the rest.
 * Reuses runAlertSend, so the send-then-record ordering and last_checked_at rule are identical to the manual flow.
 */
export async function runDailyAlerts(deps: {
  searches: SavedSearch[]
  cards: Listing[]
  alertedIdsBySearch: ReadonlyMap<string, ReadonlySet<string>>
  send: (email: AlertEmail, idempotencyKey: string) => Promise<SendResult>
  record: (rows: AlertRow[]) => Promise<{ ok: true } | { ok: false; message: string }>
  dryRun?: boolean
  now?: () => Date
  newBatchId?: () => string
}): Promise<DailyResult[]> {
  const results: DailyResult[] = []
  const safeRecord = async (rows: AlertRow[]) => {
    try {
      return await deps.record(rows)
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : 'Recording failed.' }
    }
  }

  for (const search of deps.searches) {
    const alertedIds = deps.alertedIdsBySearch.get(search.id) ?? new Set<string>()
    try {
      if (deps.dryRun) {
        const pending = pendingAlertCards(deps.cards, search, alertedIds)
        const eligible = alertEligibility(search, pending)
        results.push(
          eligible.ok
            ? { searchId: search.id, status: 'would-send', itemCount: pending.length }
            : { searchId: search.id, status: eligible.reason === 'no-email' ? 'skipped-no-email' : 'skipped-no-new', itemCount: 0 },
        )
        continue
      }
      const outcome = await runAlertSend({
        search,
        cards: deps.cards,
        alertedIds,
        send: deps.send,
        record: safeRecord,
        now: deps.now,
        newBatchId: deps.newBatchId,
      })
      switch (outcome.status) {
        case 'sent':
          results.push({ searchId: search.id, status: 'sent', itemCount: outcome.email.itemCount })
          break
        case 'ineligible':
          results.push({ searchId: search.id, status: outcome.reason === 'no-email' ? 'skipped-no-email' : 'skipped-no-new', itemCount: 0 })
          break
        case 'send-failed':
          results.push({ searchId: search.id, status: 'send-failed', itemCount: 0, message: outcome.message })
          break
        case 'sent-not-recorded':
          results.push({ searchId: search.id, status: 'sent-not-recorded', itemCount: outcome.email.itemCount, message: outcome.message })
          break
      }
    } catch (error) {
      results.push({ searchId: search.id, status: 'error', itemCount: 0, message: error instanceof Error ? error.message : 'Unexpected error.' })
    }
  }
  return results
}
