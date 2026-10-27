import { deriveFreshness, mostActiveStatus, type CoverageRun, type FreshnessListing, type FreshnessStatus } from './freshness'
import { listingLinks, type Listing } from './listings'

export const FRESHNESS_LABELS: Record<FreshnessStatus, string> = {
  legacy: 'Legacy',
  active: 'Active',
  stale: 'Stale',
  inactive: 'Inactive',
}

export const FRESHNESS_DESCRIPTIONS: Record<FreshnessStatus, string> = {
  legacy: 'Not reconfirmed by a refresh since freshness tracking started.',
  active: 'Seen by a recent refresh that could have returned it.',
  stale: 'Missed by recent refreshes that could have returned it.',
  inactive: 'Missed by several refreshes over a longer period; likely no longer available.',
}

export const COVERAGE_RUN_COLUMNS =
  'id,source,transaction_type,finished_at,status,truncated,scope_kind,neighborhoods,group_windows,min_rooms,max_rooms,min_price,max_price'

type StoredFreshnessFields = { source_url: string | null; published_at: string | null; last_seen_at?: string | null }

/**
 * Coverage is checked against the values the dashboard shows (canonical neighborhood, re-parsed deal type,
 * price and rooms), while the raw published_at and last_seen_at come from the stored row. Unknown rooms or
 * price stay null, so a run filtering on that field never counts against the listing.
 */
export function freshnessInput(listing: Listing, row: StoredFreshnessFields): FreshnessListing {
  return {
    source: listing.source,
    transaction_type: listing.dealType,
    city: listing.city,
    neighborhood: listing.neighborhood || null,
    rooms: listing.known.rooms ? listing.rooms : null,
    price: listing.known.price ? listing.price : null,
    source_url: row.source_url,
    published_at: row.published_at,
    last_seen_at: row.last_seen_at ?? null,
  }
}

export function withFreshness(listing: Listing, row: StoredFreshnessFields, runs: CoverageRun[], now: Date): Listing {
  return { ...listing, freshness: deriveFreshness(freshnessInput(listing, row), runs, now).status }
}

/**
 * After dedupe, a card takes the most active status of every source listing merged into it: the
 * cross-source members (by id) and the other Facebook posts of the same apartment (by URL).
 */
export function resolveCardFreshness(cards: Listing[], sourceListings: Listing[]): Listing[] {
  const byId = new Map<string, FreshnessStatus>()
  const byUrl = new Map<string, FreshnessStatus>()
  for (const l of sourceListings) {
    if (!l.freshness) continue
    byId.set(l.id, l.freshness)
    if (l.url) byUrl.set(l.url, l.freshness)
  }

  return cards.map((card) => {
    const statuses = [
      ...listingLinks(card).map((link) => byId.get(link.id)),
      ...(card.alsoPostedAt ?? []).map((url) => byUrl.get(url)),
      card.freshness,
    ].filter((s): s is FreshnessStatus => !!s)
    return statuses.length ? { ...card, freshness: mostActiveStatus(statuses) } : card
  })
}
