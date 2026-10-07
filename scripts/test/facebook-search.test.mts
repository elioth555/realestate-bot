/**
 * Facebook run starter tests. Offline: fetch is faked, no Apify run is started.
 * Run:
 *   node --experimental-strip-types --import ./scripts/test/register.mjs --test scripts/test/facebook-search.test.mts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_FACEBOOK_ACTOR_ID,
  buildFacebookActorInput,
  startFacebookRun,
  validateFacebookGroupUrls,
} from '../../lib/facebook-search.ts'

const groups = (n: number) => Array.from({ length: n }, (_, i) => `https://www.facebook.com/groups/${100000000 + i}`)
const env = { APIFY_API_TOKEN: 'test-token', APIFY_FACEBOOK_ACTOR_ID: 'swerve/fb-group-scraper' }

function fakeFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ data: { id: 'RunAbc12345', status: 'READY' } }), { status: 201 })
  }
  return { calls, fetch }
}

for (const [n, limit] of [
  [1, 20],
  [5, 100],
  [10, 200],
] as const) {
  test(`${n} group(s) -> resultsLimit ${limit}, maxPostsPerGroup 20`, () => {
    const input = buildFacebookActorInput(groups(n))
    assert.equal(input.resultsLimit, limit)
    assert.equal(input.maxPostsPerGroup, 20)
  })
}

test('starts one run with the exact configured URLs, no comments, no cookies, configured actor', async () => {
  const urls = groups(5)
  const { calls, fetch } = fakeFetch()
  const result = await startFacebookRun(urls, { env, fetch })
  assert.ok(result.ok)
  assert.equal(result.runId, 'RunAbc12345')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.apify.com/v2/acts/swerve~fb-group-scraper/runs')
  assert.equal(result.actorId, DEFAULT_FACEBOOK_ACTOR_ID)
  const sent = JSON.parse(String(calls[0].init?.body))
  assert.deepEqual(sent, { startUrls: urls, maxPostsPerGroup: 20, resultsLimit: 100, fetchComments: false })
  assert.equal('cookies' in sent, false)
  assert.equal('maxCommentsPerPost' in sent, false)
})

test('uses APIFY_FACEBOOK_ACTOR_ID when set, defaults to swerve/fb-group-scraper', async () => {
  const a = fakeFetch()
  await startFacebookRun(groups(1), { env: { APIFY_API_TOKEN: 't', APIFY_FACEBOOK_ACTOR_ID: 'me/other-actor' }, fetch: a.fetch })
  assert.match(a.calls[0].url, /\/acts\/me~other-actor\/runs$/)
  const b = fakeFetch()
  await startFacebookRun(groups(1), { env: { APIFY_API_TOKEN: 't' }, fetch: b.fetch })
  assert.match(b.calls[0].url, /\/acts\/swerve~fb-group-scraper\/runs$/)
})

test('empty or invalid group lists are rejected without calling Apify', async () => {
  for (const bad of [[], undefined, null, 'https://www.facebook.com/groups/1', ['https://example.com/groups/1'], ['not a url'], ['https://www.facebook.com/somepage'], [42]]) {
    const { calls, fetch } = fakeFetch()
    const result = await startFacebookRun(bad, { env, fetch })
    assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`)
    assert.equal(!result.ok && result.kind, 'invalid')
    assert.equal(calls.length, 0)
  }
})

test('URLs are canonicalized and de-duplicated', () => {
  const result = validateFacebookGroupUrls([
    'https://m.facebook.com/groups/938644249820363/',
    'https://www.facebook.com/groups/938644249820363?ref=share',
    ' https://facebook.com/groups/secrettelaviv ',
  ])
  assert.ok(result.ok)
  assert.deepEqual(result.urls, [
    'https://www.facebook.com/groups/938644249820363',
    'https://www.facebook.com/groups/secrettelaviv',
  ])
})

test('missing token is a config error and no request is made', async () => {
  const { calls, fetch } = fakeFetch()
  const result = await startFacebookRun(groups(2), { env: {}, fetch })
  assert.equal(!result.ok && result.kind, 'config')
  assert.equal(calls.length, 0)
})

test('Apify concurrency rejection is reported as limit', async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ error: { type: 'actor-memory-limit-exceeded', message: 'limit' } }), { status: 402 })
  const result = await startFacebookRun(groups(2), { env, fetch })
  assert.equal(!result.ok && result.kind, 'limit')
})
