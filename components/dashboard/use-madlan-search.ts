'use client'

import { checkMadlanRun, startMadlanSearch } from '@/app/actions/madlan'
import { useSourceRefresh, type RefreshInput, type SourceRefreshConfig } from './use-yad2-search'

export const MADLAN_REFRESH: SourceRefreshConfig = {
  source: 'madlan',
  label: 'Madlan',
  storageKey: 'realestatebot:madlan-active-run',
  start: (input) => {
    const amenities = new Set(input.amenities ?? [])
    return startMadlanSearch({
      city: input.city,
      transactionType: input.transactionType,
      minPrice: input.minPrice || null,
      maxPrice: input.maxPrice || null,
      minRooms: input.minRooms || null,
      maxRooms: input.maxRooms || null,
      parking: amenities.has('parking'),
      elevator: amenities.has('elevator'),
      balcony: amenities.has('balcony'),
      mamad: amenities.has('mamad'),
      neighborhoods: input.neighborhoods,
    })
  },
  check: checkMadlanRun,
}

export { MADLAN_AMENITY_FILTERS } from '@/lib/refresh-all'

export function useMadlanSearch(...args: Parameters<typeof useSourceRefresh> extends [unknown, ...infer Rest] ? Rest : never) {
  return useSourceRefresh(MADLAN_REFRESH, ...args)
}

export type { RefreshInput }
