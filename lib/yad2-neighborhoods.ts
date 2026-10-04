import { aliasKey } from './normalize'

/**
 * Yad2 `neighborhood` IDs for Tel Aviv.
 *
 * One dashboard neighborhood can span several Yad2 neighborhoods (e.g. Old North = northern + southern part).
 * Only add an ID once it has been confirmed against a real Yad2 search URL for that exact neighborhood.
 * Unconfirmed entries stay empty and are reported as unsupported instead of guessed.
 */
type Yad2NeighborhoodEntry = { aliases: readonly string[]; yad2Ids: readonly string[] }

export const YAD2_NEIGHBORHOODS: Record<string, Yad2NeighborhoodEntry> = {
  // 1483 = northern part, 1461 = southern part.
  'Old North': { aliases: ['Old North', 'הצפון הישן'], yad2Ids: ['1483', '1461'] },
  // 204 = northern part; the southern part is not confirmed yet.
  'New North': { aliases: ['New North', 'הצפון החדש'], yad2Ids: ['204'] },
  'Neve Tzedek': { aliases: ['Neve Tzedek', 'Neve Tsedek', 'נווה צדק'], yad2Ids: ['848'] },
  Florentin: { aliases: ['Florentin', 'פלורנטין'], yad2Ids: ['205'] },
  'Kerem HaTeimanim': { aliases: ['Kerem HaTeimanim', 'Kerem Hateimanim', 'כרם התימנים'], yad2Ids: ['1521'] },
  Bavli: { aliases: ['Bavli', 'בבלי'], yad2Ids: ['1518'] },
  Jaffa: { aliases: ['Jaffa', 'Yafo', 'יפו'], yad2Ids: [] },
  'Old Jaffa': { aliases: ['Old Jaffa', 'יפו העתיקה'], yad2Ids: [] },
  'Lev HaIr': { aliases: ['Lev HaIr', 'Lev Hair', 'לב העיר'], yad2Ids: ['1520'] },
}

// Confirmed on live Yad2 pages / Apify runs.
export const YAD2_CONFIRMED_NEIGHBORHOOD_IDS: readonly string[] = [
  '1521',
  '848',
  '1520',
  '205',
  '1518',
  '1483',
  '1461',
  '204',
]

export type Yad2NeighborhoodResolution = {
  ids: string[]
  applied: string[]
  unsupported: string[]
  notes: string[]
}

const lookup = new Map<string, { name: string; entry: Yad2NeighborhoodEntry }>()
for (const [name, entry] of Object.entries(YAD2_NEIGHBORHOODS)) {
  for (const alias of [name, ...entry.aliases]) lookup.set(aliasKey(alias), { name, entry })
}

const confirmedIds = new Set([
  ...YAD2_CONFIRMED_NEIGHBORHOOD_IDS,
  ...Object.values(YAD2_NEIGHBORHOODS).flatMap((entry) => entry.yad2Ids),
])

/** Maps dashboard neighborhood names and raw Yad2 IDs to confirmed Yad2 IDs; anything unconfirmed is reported, never guessed. */
export function resolveYad2Neighborhoods(names: string[], rawIds: string[]): Yad2NeighborhoodResolution {
  const ids = new Set<string>()
  const applied: string[] = []
  const unsupported: string[] = []
  const notes: string[] = []

  for (const raw of names) {
    const match = lookup.get(aliasKey(raw))
    if (!match) {
      unsupported.push(raw)
      notes.push(`"${raw}" is not in the Yad2 neighborhood mapping.`)
    } else if (match.entry.yad2Ids.length === 0) {
      unsupported.push(match.name)
      notes.push(`"${match.name}" has no confirmed Yad2 neighborhood ID yet.`)
    } else if (!applied.includes(match.name)) {
      match.entry.yad2Ids.forEach((id) => ids.add(id))
      applied.push(match.name)
    }
  }

  for (const id of rawIds) {
    if (!confirmedIds.has(id)) {
      unsupported.push(id)
      notes.push(`Neighborhood ID ${id} is not a confirmed Yad2 ID.`)
    } else if (!ids.has(id)) {
      ids.add(id)
      applied.push(id)
    }
  }

  return { ids: [...ids], applied, unsupported, notes }
}
