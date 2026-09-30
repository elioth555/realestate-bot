import { createHash, timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { validatePropertyInput } from '@/lib/import-listing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function jsonError(status: number, error: string, details?: string[]) {
  return NextResponse.json({ success: false, error, ...(details ? { details } : {}) }, { status })
}

function tokensMatch(provided: string, expected: string) {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (!url || !secretKey) return null
  return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

function describeDbError(error: { message: string; code?: string }) {
  if (error.code === 'PGRST204') {
    return jsonError(400, 'A submitted field does not exist in the properties table.', [error.message])
  }
  if (error.code === '22P02' || error.code === '23502' || error.code === '23514') {
    return jsonError(400, 'The database rejected one of the submitted values.', [error.message])
  }
  console.error('import-listing: database error', error)
  return jsonError(500, 'Failed to save the property.')
}

export async function POST(request: Request) {
  const expectedToken = process.env.IMPORT_API_TOKEN
  if (!expectedToken) {
    return jsonError(500, 'Import endpoint is not configured (IMPORT_API_TOKEN is missing).')
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!providedToken || !tokensMatch(providedToken, expectedToken)) {
    return jsonError(401, 'Unauthorized.')
  }

  const supabase = getAdminClient()
  if (!supabase) {
    return jsonError(500, 'Import endpoint is not configured (Supabase URL or secret key is missing).')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Request body must be valid JSON.')
  }

  const validation = validatePropertyInput(body)
  if (!validation.ok) {
    return jsonError(422, 'Validation failed.', validation.errors)
  }
  const property = validation.data

  // Look up by source_url instead of relying on an upsert, which would require a
  // unique constraint on that column (the schema must not be modified).
  const existing = await supabase
    .from('properties')
    .select('id')
    .eq('source_url', property.source_url)
    .limit(1)
    .maybeSingle()

  if (existing.error) return describeDbError(existing.error)

  if (existing.data) {
    const updated = await supabase.from('properties').update(property).eq('id', existing.data.id).select('id').single()
    if (updated.error) return describeDbError(updated.error)
    return NextResponse.json({ success: true, action: 'updated', id: updated.data.id }, { status: 200 })
  }

  const inserted = await supabase.from('properties').insert(property).select('id').single()
  if (inserted.error) {
    if (inserted.error.code === '23505') {
      return jsonError(409, 'A property with this source_url was created concurrently. Retry the request.')
    }
    return describeDbError(inserted.error)
  }

  return NextResponse.json({ success: true, action: 'created', id: inserted.data.id }, { status: 201 })
}
