import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PropertyInput } from '@/lib/import-listing'

export function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (!url || !secretKey) return null
  return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

export type UpsertResult =
  | { ok: true; action: 'created' | 'updated'; id: string | number }
  | { ok: false; error: string }

// Mirrors /api/import-listing: look up by source_url, then update or insert.
// No upsert() because source_url has no unique constraint in the schema.
export async function upsertPropertyBySourceUrl(
  supabase: SupabaseClient,
  property: PropertyInput & { source_url: string },
): Promise<UpsertResult> {
  const existing = await supabase
    .from('properties')
    .select('id')
    .eq('source_url', property.source_url)
    .limit(1)
    .maybeSingle()

  if (existing.error) return { ok: false, error: existing.error.message }

  if (existing.data) {
    const updated = await supabase.from('properties').update(property).eq('id', existing.data.id).select('id').single()
    if (updated.error) return { ok: false, error: updated.error.message }
    return { ok: true, action: 'updated', id: updated.data.id }
  }

  const inserted = await supabase.from('properties').insert(property).select('id').single()
  if (inserted.error) {
    if (inserted.error.code === '23505') {
      return { ok: false, error: 'A property with this source_url was created concurrently.' }
    }
    return { ok: false, error: inserted.error.message }
  }
  return { ok: true, action: 'created', id: inserted.data.id }
}
