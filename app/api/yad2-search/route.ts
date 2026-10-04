import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { startYad2Run, validateCriteria } from '@/lib/yad2-search'

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

export async function POST(request: Request) {
  const expectedToken = process.env.IMPORT_API_TOKEN
  if (!expectedToken) {
    return jsonError(500, 'Search endpoint is not configured (IMPORT_API_TOKEN is missing).')
  }
  const authHeader = request.headers.get('authorization') ?? ''
  const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!providedToken || !tokensMatch(providedToken, expectedToken)) {
    return jsonError(401, 'Unauthorized.')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Request body must be valid JSON.')
  }

  const validation = validateCriteria(body)
  if (!validation.ok) return jsonError(validation.status, 'Validation failed.', validation.errors)
  const criteria = validation.data

  const run = await startYad2Run(criteria)
  if (!run.ok) {
    return NextResponse.json(
      {
        success: false,
        error: run.error,
        ...(run.details ? { details: run.details } : {}),
        ...(run.actorInput ? { actor_input: run.actorInput } : {}),
      },
      { status: run.httpStatus },
    )
  }

  return NextResponse.json(
    {
      success: true,
      run_id: run.runId,
      status: run.status,
      search_url: run.searchUrl,
      neighborhood_filter_applied: false,
      ...(criteria.neighborhoodIds.length > 0
        ? {
            neighborhood_filter_note:
              'neighborhood_ids were received but are not applied: the old Yad2 URL format has no verified neighborhood parameter.',
          }
        : {}),
      actor_input: run.actorInput,
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  )
}
