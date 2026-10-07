const APIFY_API = 'https://api.apify.com/v2'
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_.-]+~[A-Za-z0-9_.-]+$/
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,32}$/
const LIMIT_ERROR_PATTERN = /limit|concurren|memory|quota|exceeded/i
const GROUP_PATH = /^\/groups\/([A-Za-z0-9._-]+)\/?$/

export const DEFAULT_FACEBOOK_ACTOR_ID = 'swerve~fb-group-scraper'
export const FACEBOOK_MAX_POSTS_PER_GROUP = 20
export const FACEBOOK_MAX_GROUPS = 25

/** Input accepted by swerve/fb-group-scraper (build 1.0.75). `cookies` is deliberately never sent. */
export type FacebookActorInput = {
  startUrls: string[]
  maxPostsPerGroup: number
  resultsLimit: number
  fetchComments: false
}

export type FacebookEnv = { APIFY_API_TOKEN?: string; APIFY_FACEBOOK_ACTOR_ID?: string }
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Canonical form: https://www.facebook.com/groups/<id-or-slug>. Returns null for anything else. */
export function canonicalFacebookGroupUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!/^(www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname)) return null
  const match = GROUP_PATH.exec(url.pathname)
  return match ? `https://www.facebook.com/groups/${match[1]}` : null
}

export function validateFacebookGroupUrls(
  urls: unknown,
): { ok: true; urls: string[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { ok: false, errors: ['No Facebook groups are configured.'] }
  }
  const errors: string[] = []
  const canonical: string[] = []
  for (const raw of urls) {
    const url = typeof raw === 'string' ? canonicalFacebookGroupUrl(raw) : null
    if (!url) errors.push(`Invalid Facebook group URL: ${String(raw)}`)
    else if (!canonical.includes(url)) canonical.push(url)
  }
  if (canonical.length > FACEBOOK_MAX_GROUPS) errors.push(`At most ${FACEBOOK_MAX_GROUPS} groups can be scanned per run.`)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, urls: canonical }
}

/** resultsLimit = groups × maxPostsPerGroup, so the global cap can never stop before every group is scanned. */
export function buildFacebookActorInput(urls: string[]): FacebookActorInput {
  return {
    startUrls: [...urls],
    maxPostsPerGroup: FACEBOOK_MAX_POSTS_PER_GROUP,
    resultsLimit: urls.length * FACEBOOK_MAX_POSTS_PER_GROUP,
    fetchComments: false,
  }
}

export function readFacebookApifyConfig(env: FacebookEnv) {
  const token = env.APIFY_API_TOKEN?.trim()
  const actorId = (env.APIFY_FACEBOOK_ACTOR_ID?.trim() || DEFAULT_FACEBOOK_ACTOR_ID).replace('/', '~')
  if (!token) return { ok: false as const, error: 'Facebook refresh is not configured (APIFY_API_TOKEN is missing).' }
  if (!ACTOR_ID_PATTERN.test(actorId)) {
    return { ok: false as const, error: 'Facebook refresh is not configured (APIFY_FACEBOOK_ACTOR_ID is invalid).' }
  }
  return { ok: true as const, token, actorId }
}

const processEnv = (): FacebookEnv => ({
  APIFY_API_TOKEN: process.env.APIFY_API_TOKEN,
  APIFY_FACEBOOK_ACTOR_ID: process.env.APIFY_FACEBOOK_ACTOR_ID,
})

export type FacebookStartResult =
  | { ok: true; runId: string; status: string; actorId: string; actorInput: FacebookActorInput }
  | { ok: false; kind: 'invalid' | 'config' | 'limit' | 'error'; error: string }

/** Starts ONE actor run covering every configured group. Results arrive via /api/apify-facebook-webhook. */
export async function startFacebookRun(
  groupUrls: unknown,
  deps: { env?: FacebookEnv; fetch?: FetchLike } = {},
): Promise<FacebookStartResult> {
  const validation = validateFacebookGroupUrls(groupUrls)
  if (!validation.ok) return { ok: false, kind: 'invalid', error: validation.errors.join(' ') }
  const config = readFacebookApifyConfig(deps.env ?? processEnv())
  if (!config.ok) return { ok: false, kind: 'config', error: config.error }

  const actorInput = buildFacebookActorInput(validation.urls)
  const doFetch = deps.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(`${APIFY_API}/acts/${encodeURIComponent(config.actorId)}/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(actorInput),
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    console.error('facebook-search: Apify request failed', error)
    return { ok: false, kind: 'error', error: 'Could not reach the Apify API.' }
  }

  const body = (await response.json().catch(() => null)) as
    | { data?: { id?: string; status?: string }; error?: { type?: string; message?: string } }
    | null
  if (!response.ok || !body?.data?.id) {
    const message = body?.error?.message ?? `Apify returned HTTP ${response.status}.`
    const limitReached =
      response.status === 402 ||
      response.status === 429 ||
      LIMIT_ERROR_PATTERN.test(`${body?.error?.type ?? ''} ${body?.error?.message ?? ''}`)
    console.error('facebook-search: Apify rejected the run', response.status, body?.error)
    return { ok: false, kind: limitReached ? 'limit' : 'error', error: message }
  }
  return { ok: true, runId: body.data.id, status: body.data.status ?? 'READY', actorId: config.actorId, actorInput }
}

export type FacebookRunStatusResult =
  | { ok: true; runId: string; status: string; finishedAt: string | null }
  | { ok: false; error: string }

/** Read-only status of a Facebook run. Runs of other actors are reported as not found. */
export async function getFacebookRunStatus(
  runId: string,
  deps: { env?: FacebookEnv; fetch?: FetchLike } = {},
): Promise<FacebookRunStatusResult> {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return { ok: false, error: 'Invalid run id.' }
  const config = readFacebookApifyConfig(deps.env ?? processEnv())
  if (!config.ok) return { ok: false, error: config.error }
  const doFetch = deps.fetch ?? fetch
  const getJson = async <T>(path: string) => {
    const res = await doFetch(`${APIFY_API}${path}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    })
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as T | null }
  }
  try {
    const [run, actor] = await Promise.all([
      getJson<{ data?: { status?: string; finishedAt?: string | null; actId?: string } }>(
        `/actor-runs/${encodeURIComponent(runId)}`,
      ),
      getJson<{ data?: { id?: string } }>(`/acts/${encodeURIComponent(config.actorId)}`),
    ])
    if (!run.ok || !run.body?.data?.status) {
      return { ok: false, error: run.status === 404 ? 'Run not found.' : `Apify returned HTTP ${run.status}.` }
    }
    const actorInternalId = actor.ok ? actor.body?.data?.id : undefined
    if (actorInternalId && run.body.data.actId && run.body.data.actId !== actorInternalId) {
      return { ok: false, error: 'Run not found.' }
    }
    return { ok: true, runId, status: run.body.data.status, finishedAt: run.body.data.finishedAt ?? null }
  } catch (error) {
    console.error('facebook-search: could not read run status', error)
    return { ok: false, error: 'Could not reach the Apify API.' }
  }
}
