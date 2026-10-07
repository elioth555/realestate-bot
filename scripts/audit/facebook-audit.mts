/**
 * Read-only audit of Facebook rows through the dashboard read path (rowToListing + dedupe). Never writes.
 * Run:
 *   node --env-file-if-exists=/vercel/share/.env.project --experimental-strip-types \
 *     --import ./scripts/test/register.mjs scripts/audit/facebook-audit.mts
 */
import { rowToListing, type PropertyRow } from '../../lib/supabase.ts'
import { dedupeFacebookListings } from '../../lib/facebook-dedupe.ts'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
if (!url || !key) throw new Error('Supabase env vars missing')
const res = await fetch(`${url}/rest/v1/properties?source=ilike.*facebook*&select=*&order=id`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
})
const rows = (await res.json()) as PropertyRow[]
const listings = rows.map((r) => rowToListing(r))

const ROOMS_MENTION = /(\d{1,2}(?:[.,]5)?)\s*(?:חדרים|חד['׳"]|חדר(?![\p{L}])|rooms?\b)|דירת\s+חדר(?![\p{L}])|חדר\s+וחצי/iu
const PRICE_MENTION = /₪|ש["״]?ח|שקל|מחיר|לחודש|nis\b/i
const PHONE_MENTION = /0[5-9]\d[\s-]?\d{3}[\s-]?\d{4}|\+?972/

const pct = (n: number, d: number) => `${n}/${d} (${d ? Math.round((n / d) * 100) : 0}%)`
const verbose = process.argv.includes('--verbose')
const tlv = listings.filter((l) => l.city === 'תל אביב')
console.log('rows', rows.length, '| unique urls', new Set(rows.map((r) => r.source_url)).size)
console.log('neighborhood resolved (all)', pct(listings.filter((l) => l.neighborhood).length, listings.length))
console.log('neighborhood resolved (Tel Aviv)', pct(tlv.filter((l) => l.neighborhood).length, tlv.length))
console.log('street present', pct(listings.filter((l) => l.street).length, listings.length))
console.log('street but no neighborhood', listings.filter((l) => l.street && !l.neighborhood).length)
console.log('rooms known', pct(listings.filter((l) => l.known.rooms).length, listings.length))
const missedRooms = listings.filter((l) => !l.known.rooms && ROOMS_MENTION.test(l.description))
console.log('rooms mentioned but missing', missedRooms.length)
if (verbose) {
  for (const l of missedRooms) {
    const d = l.description.replace(/\s+/g, ' ')
    const i = d.search(ROOMS_MENTION)
    console.log('   ', l.id, '|', d.slice(Math.max(0, i - 25), i + 30))
  }
}
console.log('price mentioned but missing', listings.filter((l) => !l.known.price && PRICE_MENTION.test(l.description)).length)
console.log('phone mentioned but missing', listings.filter((l) => !l.phone && PHONE_MENTION.test(l.description)).length)
const streetCounts = new Map<string, number>()
for (const l of listings) if (l.street) streetCounts.set(l.street, (streetCounts.get(l.street) ?? 0) + 1)
console.log('top streets', JSON.stringify([...streetCounts].sort((a, b) => b[1] - a[1]).slice(0, 12)))
if (verbose) {
  for (const l of listings) if (l.street) console.log('   street', l.id, JSON.stringify(l.street), '->', l.neighborhood || '-')
}
const sameText = new Map<string, string[]>()
for (const l of listings) {
  const k = l.description.replace(/[^\p{L}\p{N}]+/gu, '')
  if (k) sameText.set(k, [...(sameText.get(k) ?? []), l.id])
}
const clusters = [...sameText.values()].filter((ids) => ids.length > 1)
console.log('identical-text clusters', clusters.length, '| rows in them', clusters.flat().length)
const shown = dedupeFacebookListings(listings)
const merged = shown.filter((l) => (l.alsoPostedAt?.length ?? 0) > 0)
console.log('displayed after dedupe', shown.length, '| merged clusters', merged.length)
if (verbose) {
  for (const l of merged) console.log('   cluster', l.id, '+', l.alsoPostedAt!.length, JSON.stringify(l.street), l.price, l.rooms, l.phone)
}
