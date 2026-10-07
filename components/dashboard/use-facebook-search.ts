'use client'

import { checkFacebookRun, startFacebookRefresh } from '@/app/actions/facebook'
import { useSourceRefresh, type RefreshInput, type SourceRefreshConfig } from './use-yad2-search'

/**
 * Facebook scans the server-side group list (lib/facebook-groups.ts) and ignores dashboard filters, so its
 * refresh always uses this one fixed input: one stable signature, one tracked run at a time.
 */
export const FACEBOOK_REFRESH_INPUT: RefreshInput = {
  city: null,
  transactionType: 'rent',
  minRooms: null,
  maxRooms: null,
  minPrice: '',
  maxPrice: '',
  neighborhoods: [],
}

export const FACEBOOK_REFRESH: SourceRefreshConfig = {
  source: 'facebook',
  label: 'Facebook',
  storageKey: 'realestatebot:facebook-active-run',
  start: async () => {
    const result = await startFacebookRefresh()
    if (!result.ok) {
      return { ok: false, kind: result.kind === 'config' ? 'error' : result.kind, message: result.message }
    }
    return { ok: true, runIds: [result.runId], status: result.status, startFailures: 0, startLimitReached: false }
  },
  check: checkFacebookRun,
}

export function useFacebookSearch(
  ...args: Parameters<typeof useSourceRefresh> extends [unknown, unknown, ...infer Rest] ? Rest : never
) {
  return useSourceRefresh(FACEBOOK_REFRESH, FACEBOOK_REFRESH_INPUT, ...args)
}
