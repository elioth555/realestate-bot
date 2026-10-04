import { aliasKey } from './normalize'

/**
 * Yad2 `multiNeighborhood` IDs for Tel Aviv.
 *
 * Only add a `yad2Id` once it has been confirmed against a real Yad2 search URL for that exact
 * neighborhood. Unconfirmed entries stay `null` and are reported as unsupported instead of guessed.
 */
type Yad2NeighborhoodEntry = { aliases: readonly string[]; yad2Id: string | null }

export const YAD2_NEIGHBORHOODS: Record<string, Yad2NeighborhoodEntry> = {
  'Old North': { aliases: ['Old North', 'הצפון הישן'], yad2Id: null },
  'New North': { aliases: ['New North', 'הצפון החדש'], yad2Id: null },
  'Neve Tzedek': { aliases: ['Neve Tzedek', 'Neve Tsedek', 'נווה צדק'], yad2Id: '848' },
  Florentin: { aliases: ['Florentin', 'פלורנטין'], yad2Id: null },
  'Kerem HaTeimanim': { aliases: ['Kerem HaTeimanim', 'Kerem Hateimanim', 'כרם התימנים'], yad2Id: null },
  Bavli: { aliases: ['Bavli', 'בבלי'], yad2Id: null },
  Jaffa: { aliases: ['Jaffa', 'Yafo', 'יפו'], yad2Id: null },
  'Old Jaffa': { aliases: ['Old Jaffa', 'יפו העתיקה'], yad2Id: null },
  'Lev HaIr': { aliases: ['Lev HaIr', 'Lev Hair', 'לב העיר'], yad2Id: null },
}

// Confirmed valid on Yad2 (used in a working search URL). 848 is Neve Tzedek; 1521 and 1520 are not yet identified by name.
export const YAD2_CONFIRMED_NEIGHBORHOOD_IDS: readonly string[] = ['1521', '848', '1520']

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
  ...Object.values(YAD2_NEIGHBORHOODS).flatMap((entry) => (entry.yad2Id ? [entry.yad2Id] : [])),
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
    } else if (!match.entry.yad2Id) {
      unsupported.push(match.name)
      notes.push(`"${match.name}" has no confirmed Yad2 neighborhood ID yet.`)
    } else if (!ids.has(match.entry.yad2Id)) {
      ids.add(match.entry.yad2Id)
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
