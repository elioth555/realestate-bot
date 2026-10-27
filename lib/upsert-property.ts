import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PropertyInput } from '@/lib/import-listing'
import { laterTimestamp, type RefreshRunRow } from '@/lib/freshness'

export type RecordRunResult = { recorded: boolean; duplicate?: boolean; status?: string; error?: string; reason?: string }

/**
 * Inserts one source_refresh_runs row after the import finished. A webhook retry for the same Apify run
 * is ignored (actor_run_id is unique). Failure here never fails the import: the sightings already saved are real.
 */
export async function recordRefreshRun(supabase: SupabaseClient, row: RefreshRunRow): Promise<RecordRunResult> {
  const result = await supabase
    .from('source_refresh_runs')
    .upsert(row, { onConflict: 'actor_run_id', ignoreDuplicates: true })
    .select('id')
  if (result.error) return { recorded: false, status: row.status, error: result.error.message }
  const duplicate = Array.isArray(result.data) && result.data.length === 0
  return { recorded: !duplicate, duplicate, status: row.status }
}

export function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (!url || !secretKey) return null
  return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

export type UpsertResult =
  | { ok: true; action: 'created' | 'updated'; id: string | number }
  | { ok: false; error: string }

export type UpsertOptions = {
  /** Refresh run finish time. Written to last_seen_at on insert and update; never moves it backwards. */
  seenAt?: string
}

// Mirrors /api/import-listing: look up by source_url, then update or insert.
// No upsert() because source_url has no unique constraint in the schema.
// first_seen_at is never sent: the column default sets it on insert and updates leave it alone.
export async function upsertPropertyBySourceUrl(
  supabase: SupabaseClient,
  property: PropertyInput & { source_url: string },
  options: UpsertOptions = {},
): Promise<UpsertResult> {
  const { seenAt } = options
  const existing = await supabase
    .from('properties')
    .select(seenAt ? 'id, last_seen_at' : 'id')
    .eq('source_url', property.source_url)
    .limit(1)
    .maybeSingle<{ id: string | number; last_seen_at?: string | null }>()

  if (existing.error) return { ok: false, error: existing.error.message }

  if (existing.data) {
    const row = seenAt ? { ...property, last_seen_at: laterTimestamp(existing.data.last_seen_at, seenAt) } : property
    const updated = await supabase.from('properties').update(row).eq('id', existing.data.id).select('id').single()
    if (updated.error) return { ok: false, error: updated.error.message }
    return { ok: true, action: 'updated', id: updated.data.id }
  }

  const insertRow = seenAt ? { ...property, last_seen_at: seenAt } : property
  const inserted = await supabase.from('properties').insert(insertRow).select('id').single()
  if (inserted.error) {
    if (inserted.error.code === '23505') {
      return { ok: false, error: 'A property with this source_url was created concurrently.' }
    }
    return { ok: false, error: inserted.error.message }
  }
  return { ok: true, action: 'created', id: inserted.data.id }
}
