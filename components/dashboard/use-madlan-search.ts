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

/** Amenities the Madlan actor can filter on server-side; every other amenity still filters locally. */
export const MADLAN_AMENITY_FILTERS = ['parking', 'elevator', 'balcony', 'mamad'] as const

export function useMadlanSearch(...args: Parameters<typeof useSourceRefresh> extends [unknown, ...infer Rest] ? Rest : never) {
  return useSourceRefresh(MADLAN_REFRESH, ...args)
}

export type { RefreshInput }
