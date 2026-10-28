'use server'

import { getAdminClient } from '@/lib/upsert-property'
import { fetchListings } from '@/lib/supabase'
import { SAVED_SEARCH_COLUMNS, isSavedSearchId, rowToSavedSearch, type SavedSearch, type SavedSearchRow } from '@/lib/saved-searches'
import {
  ALERT_CHANNEL,
  INELIGIBLE_MESSAGES,
  alertEligibility,
  buildAlertEmail,
  pendingAlertCards,
  runAlertSend,
  type AlertEmail,
  type AlertRow,
} from '@/lib/saved-search-alerts'
import { sendWithResend } from '@/lib/alert-email-sender'

type Failure = { ok: false; message: string; setupRequired?: boolean; notConfigured?: boolean }
export type AlertActionResult<T> = { ok: true; data: T } | Failure

const SETUP_MESSAGE = 'Email alerts need the saved_search_alerts table. Run scripts/sql/saved-search-alerts.sql in the Supabase SQL editor.'

function failure(error: { message: string; code?: string } | null, fallback: string): Failure {
  if (error && ['42P01', 'PGRST205', '42501'].includes(error.code ?? '')) return { ok: false, message: SETUP_MESSAGE, setupRequired: true }
  if (error) console.error(`[saved-search-alerts] ${fallback}:`, error.code, error.message)
  return { ok: false, message: fallback }
}

/** Alerted source-listing ids per saved search, for the "unsent new matches" count on the dashboard. */
export async function listAlertedListingIds(): Promise<AlertActionResult<Record<string, string[]>>> {
  const supabase = getAdminClient()
  if (!supabase) return { ok: false, message: 'Email alerts need SUPABASE_SECRET_KEY on the server.' }
  const { data, error } = await supabase
    .from('saved_search_alerts')
    .select('saved_search_id,listing_id')
    .eq('channel', ALERT_CHANNEL)
    .limit(20000)
  if (error) return failure(error, 'Could not load sent alerts.')
  const bySearch: Record<string, string[]> = {}
  for (const row of (data ?? []) as { saved_search_id: string; listing_id: string }[]) {
    ;(bySearch[row.saved_search_id] ??= []).push(row.listing_id)
  }
  return { ok: true, data: bySearch }
}

type Context = { search: SavedSearch; alertedIds: Set<string>; cards: Awaited<ReturnType<typeof fetchListings>> }

/** Everything is recomputed on the server from Supabase, the same way the dashboard does it. */
async function loadContext(searchId: string): Promise<AlertActionResult<Context>> {
  const supabase = getAdminClient()
  if (!supabase) return { ok: false, message: 'Email alerts need SUPABASE_SECRET_KEY on the server.' }
  if (!isSavedSearchId(searchId)) return { ok: false, message: 'Unknown saved search.' }

  const [searchRes, alertsRes] = await Promise.all([
    supabase.from('saved_searches').select(SAVED_SEARCH_COLUMNS).eq('id', searchId).maybeSingle(),
    supabase.from('saved_search_alerts').select('listing_id').eq('saved_search_id', searchId).eq('channel', ALERT_CHANNEL).limit(20000),
  ])
  if (searchRes.error) return failure(searchRes.error, 'Could not load the saved search.')
  if (alertsRes.error) return failure(alertsRes.error, 'Could not load sent alerts.')
  const search = searchRes.data ? rowToSavedSearch(searchRes.data as SavedSearchRow) : null
  if (!search) return { ok: false, message: 'That saved search no longer exists.' }

  let cards: Context['cards']
  try {
    cards = await fetchListings()
  } catch (error) {
    console.error('[saved-search-alerts] could not load listings:', error instanceof Error ? error.message : error)
    return { ok: false, message: 'Could not load listings.' }
  }
  const alertedIds = new Set(((alertsRes.data ?? []) as { listing_id: string }[]).map((r) => r.listing_id))
  return { ok: true, data: { search, alertedIds, cards } }
}

/** Test mode: builds the exact email without sending anything or writing anything. */
export async function previewSavedSearchAlert(searchId: string): Promise<AlertActionResult<AlertEmail>> {
  const ctx = await loadContext(searchId)
  if (!ctx.ok) return ctx
  const pending = pendingAlertCards(ctx.data.cards, ctx.data.search, ctx.data.alertedIds)
  const eligible = alertEligibility(ctx.data.search, pending)
  if (!eligible.ok) return { ok: false, message: INELIGIBLE_MESSAGES[eligible.reason] }
  return { ok: true, data: buildAlertEmail(ctx.data.search, pending) }
}

export async function sendSavedSearchAlert(searchId: string): Promise<AlertActionResult<{ itemCount: number; to: string }>> {
  const ctx = await loadContext(searchId)
  if (!ctx.ok) return ctx
  const supabase = getAdminClient()
  if (!supabase) return { ok: false, message: 'Email alerts need SUPABASE_SECRET_KEY on the server.' }

  const outcome = await runAlertSend({
    ...ctx.data,
    send: sendWithResend,
    record: async (rows: AlertRow[]) => {
      const { error } = await supabase
        .from('saved_search_alerts')
        .upsert(rows, { onConflict: 'saved_search_id,listing_id,channel', ignoreDuplicates: true })
      return error ? failure(error, 'Could not record the sent alert.') : { ok: true as const }
    },
  })

  switch (outcome.status) {
    case 'sent':
      return { ok: true, data: { itemCount: outcome.email.itemCount, to: outcome.email.to } }
    case 'ineligible':
      return { ok: false, message: INELIGIBLE_MESSAGES[outcome.reason] }
    case 'send-failed':
      return { ok: false, message: outcome.message, notConfigured: outcome.notConfigured }
    case 'sent-not-recorded':
      return { ok: false, message: `The email was sent to ${outcome.email.to}, but recording it failed: ${outcome.message} Do not resend until this is fixed.` }
  }
}
