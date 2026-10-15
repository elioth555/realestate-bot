import { AMENITY_KEYS, type Listing, type ListingLink, type TriState } from './listings'

/**
 * Read-time grouping of the same apartment listed on different sources (Facebook / Yad2 / Madlan).
 * Stored rows are never touched; same-source duplicates are left to lib/facebook-dedupe.
 *
 * Two listings merge only when nothing contradicts it AND one signal identifies the apartment itself
 * (same street + house number, the same real phone, or near-identical text) AND price and rooms agree,
 * plus surface or floor. Neighborhood, street name, or price alone never merges.
 */

const TEXT_SIMILAR = 0.6

type Prepared = {
  listing: Listing
  address: string | null
  houseNumber: string | null
  phone: string | null
  tokens: Set<string>
}

/** Strips Yad2's ", neighborhood" suffix, "רחוב" prefixes, a leading ה, and punctuation. */
export function normalizeAddress(street: string): { address: string | null; houseNumber: string | null } {
  const main = street.split(',')[0].trim()
  const m = main.match(/^(.*?\D)\s*(\d{1,4})\s*[א-תa-z]?$/i)
  if (!m) return { address: null, houseNumber: null }
  const name = m[1]
    .replace(/^\s*(רחוב|רח['׳]?)\s+/, '')
    .replace(/["'׳״`.\s-]+/g, '')
    .replace(/^ה(?=.{3,})/, '')
    .toLowerCase()
  return name ? { address: `${name}|${m[2]}`, houseNumber: m[2] } : { address: null, houseNumber: null }
}

/** Normalized Israeli phone, or null for missing / placeholder numbers such as 0500000000. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`
  if (digits.length < 9 || digits.length > 10) return null
  if (/(\d)\1{6,}/.test(digits)) return null
  return digits
}

function tokens(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[\u0591-\u05C7]/g, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2),
  )
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (a.size < 8 || b.size < 8) return 0
  let shared = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const w of small) if (large.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

function prepare(listing: Listing): Prepared {
  return {
    listing,
    ...(({ address, houseNumber }) => ({ address, houseNumber }))(normalizeAddress(listing.street)),
    phone: normalizePhone(listing.phone),
    tokens: tokens(listing.description),
  }
}

const priceClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(100, 0.03 * Math.max(a, b))
const surfaceClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(3, 0.05 * Math.max(a, b))

/** Any known field that disagrees means these are different apartments. */
export function contradicts(a: Prepared, b: Prepared): boolean {
  const la = a.listing
  const lb = b.listing
  if (la.dealType !== lb.dealType) return true
  if (la.known.price && lb.known.price && !priceClose(la.price, lb.price)) return true
  if (la.known.rooms && lb.known.rooms && la.rooms !== lb.rooms) return true
  if (la.known.surface && lb.known.surface && !surfaceClose(la.surface, lb.surface)) return true
  if (la.floor !== null && lb.floor !== null && la.floor !== lb.floor) return true
  if (la.city && lb.city && la.city !== lb.city) return true
  if (la.neighborhood && lb.neighborhood && la.neighborhood !== lb.neighborhood) return true
  if (a.houseNumber && b.houseNumber && a.address !== b.address) return true
  if (a.phone && b.phone && a.phone !== b.phone) return true
  return false
}

/** Number of agreeing signals when the pair is the same apartment, otherwise 0. */
export function matchStrength(a: Prepared, b: Prepared): number {
  if (a.listing.source === b.listing.source || contradicts(a, b)) return 0
  const la = a.listing
  const lb = b.listing
  const sameAddress = a.address !== null && a.address === b.address
  const samePhone = a.phone !== null && a.phone === b.phone
  const similarText = jaccard(a.tokens, b.tokens) >= TEXT_SIMILAR
  if (!sameAddress && !samePhone && !similarText) return 0

  const price = la.known.price && lb.known.price
  const rooms = la.known.rooms && lb.known.rooms
  const surface = la.known.surface && lb.known.surface
  const floor = la.floor !== null && lb.floor !== null
  if (!price || !rooms) return 0
  // An address pins the building, so surface or floor is enough; a phone or text match also needs surface.
  if (sameAddress ? !surface && !floor : !surface) return 0
  return [sameAddress, samePhone, similarText, price, rooms, surface, floor].filter(Boolean).length
}

/** Data quality only; no source is preferred for its own sake. */
export function qualityScore(l: Listing) {
  const { houseNumber } = normalizeAddress(l.street)
  return (
    Math.min(l.photos.length, 8) * 2 +
    (houseNumber ? 3 : l.street ? 1 : 0) +
    Number(l.known.rooms) * 2 +
    Number(l.known.surface) * 2 +
    Number(l.floor !== null) * 2 +
    (l.description.length >= 80 ? 2 : l.description ? 1 : 0) +
    Number(Boolean(normalizePhone(l.phone))) * 2
  )
}

function photoKey(url: string) {
  return url.split('?')[0]
}

function mergeCluster(members: Listing[]): Listing {
  const [rep, ...rest] = [...members].sort(
    (a, b) => qualityScore(b) - qualityScore(a) || a.publishedMinutesAgo - b.publishedMinutesAgo,
  )
  const firstKnown = <T,>(pick: (l: Listing) => T | null | undefined) => {
    for (const l of rest) {
      const v = pick(l)
      if (v !== null && v !== undefined && v !== '') return v
    }
    return null
  }

  const known = { ...rep.known }
  const fill = (key: 'price' | 'rooms' | 'surface') => {
    if (known[key]) return rep[key]
    const donor = rest.find((l) => l.known[key])
    if (!donor) return rep[key]
    known[key] = true
    return donor[key]
  }

  // Unknown features take the other sources' answer only when they agree with each other.
  const features = { ...rep.features }
  for (const key of AMENITY_KEYS) {
    if (features[key] !== 'unknown') continue
    const answers = new Set(rest.map((l) => l.features[key]).filter((v): v is TriState => v !== 'unknown'))
    if (answers.size === 1) features[key] = [...answers][0]
  }

  const seen = new Set<string>()
  const photos: string[] = []
  for (const url of [rep, ...rest].flatMap((l) => l.photos)) {
    const k = photoKey(url)
    if (url && !seen.has(k)) {
      seen.add(k)
      photos.push(url)
    }
  }

  const listedAt: ListingLink[] = [rep, ...rest].flatMap((l) => (l.listedAt?.length ? l.listedAt : [linkOf(l)]))
  const phones = [...new Set([rep, ...rest].flatMap((l) => l.phones ?? [l.phone]).filter((p) => normalizePhone(p)))]
  const alsoPostedAt = [...new Set([rep, ...rest].flatMap((l) => l.alsoPostedAt ?? []))]

  return {
    ...rep,
    price: fill('price'),
    rooms: fill('rooms'),
    surface: fill('surface'),
    known,
    floor: rep.floor ?? firstKnown((l) => l.floor),
    street: rep.street || (firstKnown((l) => l.street) ?? ''),
    neighborhood: rep.neighborhood || (firstKnown((l) => l.neighborhood) ?? ''),
    description: rep.description || (firstKnown((l) => l.description) ?? ''),
    phone: normalizePhone(rep.phone) ? rep.phone : (phones[0] ?? rep.phone),
    features,
    amenities: AMENITY_KEYS.filter((key) => features[key] === 'yes'),
    protectedSpaceType: rep.protectedSpaceType ?? (features.mamad === 'yes' ? firstKnown((l) => l.protectedSpaceType) : null),
    photos,
    image: photos[0] ?? null,
    listedAt,
    phones,
    ...(alsoPostedAt.length ? { alsoPostedAt } : {}),
  }
}

function linkOf(l: Listing): ListingLink {
  return { source: l.source, url: l.url, id: l.id }
}

/** One card per real apartment across sources; every original source, URL and phone is kept on the card. */
export function dedupeAcrossSources(listings: Listing[]): Listing[] {
  const prepared = listings.map(prepare)
  const buckets = new Map<string, number[]>()
  const addTo = (key: string, i: number) => buckets.set(key, [...(buckets.get(key) ?? []), i])
  prepared.forEach((p, i) => {
    if (p.address) addTo(`addr:${p.address}`, i)
    if (p.phone) addTo(`phone:${p.phone}`, i)
    if (p.tokens.size >= 8 && p.listing.known.rooms) addTo(`text:${p.listing.dealType}|${p.listing.rooms}`, i)
  })

  const candidates: { i: number; j: number; strength: number }[] = []
  const compared = new Set<string>()
  for (const members of buckets.values()) {
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const [i, j] = [members[x], members[y]]
        const pair = `${Math.min(i, j)}:${Math.max(i, j)}`
        if (compared.has(pair)) continue
        compared.add(pair)
        const strength = matchStrength(prepared[i], prepared[j])
        if (strength) candidates.push({ i, j, strength })
      }
    }
  }
  if (!candidates.length) return listings

  // Strongest pairs first. A cluster holds at most one listing per source and no internal contradiction,
  // so a chain of loose matches can never pull two different apartments together.
  candidates.sort((a, b) => b.strength - a.strength)
  const clusterOf = prepared.map((_, i) => i)
  const members = new Map<number, number[]>(prepared.map((_, i) => [i, [i]]))
  for (const { i, j } of candidates) {
    const [ci, cj] = [clusterOf[i], clusterOf[j]]
    if (ci === cj) continue
    const a = members.get(ci)!
    const b = members.get(cj)!
    const sources = new Set(a.map((k) => prepared[k].listing.source))
    if (b.some((k) => sources.has(prepared[k].listing.source))) continue
    if (a.some((x) => b.some((y) => contradicts(prepared[x], prepared[y])))) continue
    const merged = [...a, ...b]
    for (const k of b) clusterOf[k] = ci
    members.set(ci, merged)
    members.delete(cj)
  }

  const replacement = new Map<number, Listing>()
  for (const [root, group] of members) {
    if (group.length > 1) replacement.set(root, mergeCluster(group.map((k) => prepared[k].listing)))
  }
  if (!replacement.size) return listings

  const out: Listing[] = []
  listings.forEach((l, i) => {
    const root = clusterOf[i]
    if (members.get(root)!.length === 1) out.push(l)
    else if (members.get(root)![0] === i) out.push(replacement.get(root)!)
  })
  return out
}
