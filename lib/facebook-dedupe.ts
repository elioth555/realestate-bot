import type { Listing } from './listings'

/**
 * Read-time grouping of the same Facebook apartment posted several times (several groups, or reposts).
 * Stored rows are never touched. Non-Facebook listings pass through unchanged.
 *
 * Two posts are the same apartment only when nothing contradicts it (price, rooms, surface, house number,
 * deal type) AND at least three strong signals agree, one of which identifies the apartment itself:
 * near-identical text, the same phone, or the same street + house number. Same street, same price or same
 * neighborhood alone never merges.
 */

const TEXT_SIMILAR = 0.85
const MIN_SIGNALS = 3

type Prepared = {
  listing: Listing
  tokens: Set<string>
  address: string | null
  addressNumber: string | null
}

function normalizedTokens(text: string) {
  const words = text
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2)
  return new Set(words)
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0
  let shared = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const w of small) if (large.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

function parseAddress(street: string) {
  const m = street.trim().match(/^(.*?\D)\s*(\d{1,4})\s*[א-תa-z]?$/i)
  if (!m) return { address: null, addressNumber: null }
  const name = m[1].replace(/["'׳״`.\s-]+/g, '')
  return name ? { address: `${name}|${m[2]}`, addressNumber: m[2] } : { address: null, addressNumber: null }
}

function streetName(street: string) {
  return street.replace(/\d+\s*[א-תa-z]?$/i, '').replace(/["'׳״`.\s-]+/g, '')
}

function prepare(listing: Listing): Prepared {
  return {
    listing,
    tokens: normalizedTokens(`${listing.title} ${listing.description}`),
    ...parseAddress(listing.street),
  }
}

export function isSameApartment(a: Prepared, b: Prepared): boolean {
  const la = a.listing
  const lb = b.listing
  if (la.dealType !== lb.dealType) return false
  if (la.known.price && lb.known.price && la.price !== lb.price) return false
  if (la.known.rooms && lb.known.rooms && la.rooms !== lb.rooms) return false
  if (la.known.surface && lb.known.surface && Math.abs(la.surface - lb.surface) > 3) return false
  if (a.addressNumber && b.addressNumber && a.address !== b.address) return false

  const similarText = jaccard(a.tokens, b.tokens) >= TEXT_SIMILAR
  const samePhone = Boolean(la.phone) && la.phone === lb.phone
  const sameAddress = a.address !== null && a.address === b.address
  if (!similarText && !samePhone && !sameAddress) return false

  // Same street name only supports an identity signal; it is never enough on its own.
  const sameStreetName = !sameAddress && Boolean(la.street) && streetName(la.street) === streetName(lb.street)
  const signals = [
    similarText,
    samePhone,
    sameAddress,
    sameStreetName,
    la.known.price && lb.known.price,
    la.known.rooms && lb.known.rooms,
    la.known.surface && lb.known.surface,
  ].filter(Boolean).length
  return signals >= MIN_SIGNALS
}

function completeness(l: Listing) {
  return (
    Number(l.known.price) +
    Number(l.known.rooms) +
    Number(l.known.surface) +
    Number(Boolean(l.phone)) +
    Number(Boolean(l.street)) +
    Number(Boolean(l.neighborhood)) +
    Number(l.photos.length > 0)
  )
}

/** Best record first: most complete, then most recently published. */
function compareRepresentative(a: Listing, b: Listing) {
  return completeness(b) - completeness(a) || a.publishedMinutesAgo - b.publishedMinutesAgo
}

/** Groups Facebook duplicates; keeps one representative per apartment with the other post URLs in `alsoPostedAt`. */
export function dedupeFacebookListings(listings: Listing[]): Listing[] {
  const prepared = listings.filter((l) => l.source === 'facebook').map(prepare)
  if (prepared.length < 2) return listings

  const parent = prepared.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))

  // Only compare posts that share a cheap key, so this stays fast with hundreds of posts.
  const buckets = new Map<string, number[]>()
  const addTo = (key: string, i: number) => buckets.set(key, [...(buckets.get(key) ?? []), i])
  prepared.forEach((p, i) => {
    if (p.listing.phone) addTo(`phone:${p.listing.phone}`, i)
    if (p.address) addTo(`addr:${p.address}`, i)
    if (p.listing.known.price) addTo(`price:${p.listing.price}`, i)
    const head = [...p.tokens].slice(0, 12).join(' ')
    if (head) addTo(`text:${head}`, i)
  })
  const compared = new Set<string>()
  for (const members of buckets.values()) {
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const [i, j] = [members[x], members[y]]
        const pair = `${i}:${j}`
        if (compared.has(pair) || find(i) === find(j)) continue
        compared.add(pair)
        if (isSameApartment(prepared[i], prepared[j])) parent[find(j)] = find(i)
      }
    }
  }

  const clusters = new Map<number, Listing[]>()
  prepared.forEach((p, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), p.listing]))

  const replacement = new Map<string, Listing | null>()
  for (const members of clusters.values()) {
    if (members.length === 1) continue
    const [best, ...rest] = [...members].sort(compareRepresentative)
    const urls = [...new Set(rest.map((l) => l.url).filter((u) => u && u !== best.url))]
    replacement.set(best.id, { ...best, alsoPostedAt: urls })
    for (const l of rest) replacement.set(l.id, null)
  }
  if (!replacement.size) return listings

  const out: Listing[] = []
  for (const l of listings) {
    if (!replacement.has(l.id)) out.push(l)
    else {
      const r = replacement.get(l.id)
      if (r) out.push(r)
    }
  }
  return out
}
