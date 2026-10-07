'use server'

import { FACEBOOK_GROUP_URLS } from '@/lib/facebook-groups'
import { getFacebookRunStatus, startFacebookRun } from '@/lib/facebook-search'

export type StartFacebookRefreshResult =
  | { ok: true; runId: string; status: string; groupCount: number }
  | { ok: false; kind: 'invalid' | 'config' | 'limit' | 'error'; message: string }

export type FacebookRunStatus = { ok: true; status: string; finishedAt: string | null } | { ok: false; message: string }

/** Starts one Facebook run over the server-side group list. Returns the run id for later polling. */
export async function startFacebookRefresh(): Promise<StartFacebookRefreshResult> {
  const result = await startFacebookRun(FACEBOOK_GROUP_URLS)
  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind,
      message:
        result.kind === 'limit'
          ? 'Apify concurrency limit reached: another run is still active, so this Facebook refresh could not start. Try again once it finishes.'
          : result.error,
    }
  }
  return { ok: true, runId: result.runId, status: result.status, groupCount: result.actorInput.startUrls.length }
}

export async function checkFacebookRun(runId: string): Promise<FacebookRunStatus> {
  const result = await getFacebookRunStatus(runId)
  return result.ok ? { ok: true, status: result.status, finishedAt: result.finishedAt } : { ok: false, message: result.error }
}
