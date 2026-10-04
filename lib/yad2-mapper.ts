import type { PropertyInput } from '@/lib/import-listing'

export type Yad2Item = Record<string, unknown>

const TRUE_STRINGS = ['true', 'yes', 'y', '1', 'כן', 'יש']
const FALSE_STRINGS = ['false', 'no', 'n', '0', 'לא', 'אין']
const GROUND_FLOOR_STRINGS = ['קרקע', 'ground', 'ground floor']

function cleanString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const str = cleanString(value)
  if (!str) return null
  const match = str.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

function toFloor(value: unknown): number | null {
  const str = cleanString(value)?.toLowerCase()
  if (str && GROUND_FLOOR_STRINGS.some((g) => str.includes(g))) return 0
  return toNumber(value)
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value > 0 : null
  const str = cleanString(value)?.toLowerCase()
  if (!str) return null
  if (TRUE_STRINGS.includes(str)) return true
  if (FALSE_STRINGS.includes(str)) return false
  const n = toNumber(str)
  return n === null ? null : n > 0
}

function inferCondition(value: unknown): Pick<PropertyInput, 'renovated' | 'new_building'> {
  const condition = cleanString(value)?.toLowerCase()
  if (!condition) return { renovated: null, new_building: null }

  if (condition.includes('קבלן') || condition.includes('contractor')) {
    return { renovated: null, new_building: true }
  }
  if (condition.includes('דרוש שיפוץ') || condition.includes('needs renovation')) {
    return { renovated: false, new_building: false }
  }
  if (condition.includes('משופץ') || condition.includes('renovated')) {
    return { renovated: true, new_building: null }
  }
  return { renovated: null, new_building: null }
}

// properties.available_from is a DATE column, so only real calendar dates are stored.
// "Immediate" entry can't be represented there; the matcher still picks it up from the description.
function toEntranceDate(value: unknown): string | null {
  const str = cleanString(value)
  if (!str) return null
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  const dmy = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/)
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : []
  if (!y) return null
  const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date) ? date : null
}

type ParsedLocation = { city: string | null; neighborhood: string | null; street: string | null }

function pickString(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = obj[key]
    const value =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? cleanString((raw as Record<string, unknown>).text ?? (raw as Record<string, unknown>).name)
        : cleanString(raw)
    if (value) return value
  }
  return null
}

function parseLocation(location: unknown): ParsedLocation {
  if (location && typeof location === 'object' && !Array.isArray(location)) {
    const obj = location as Record<string, unknown>
    const street = pickString(obj, ['street', 'streetName', 'address'])
    const houseNumber = pickString(obj, ['house_number', 'houseNumber', 'number'])
    return {
      city: pickString(obj, ['city', 'cityName', 'town', 'settlement']),
      neighborhood: pickString(obj, ['neighborhood', 'neighbourhood', 'hood', 'neighborhoodName']),
      street: street && houseNumber && !street.includes(houseNumber) ? `${street} ${houseNumber}` : street,
    }
  }

  const str = cleanString(location)
  if (!str) return { city: null, neighborhood: null, street: null }

  // Yad2 location strings are typically "street, neighborhood, city" (most specific first).
  const parts = str
    .split(/[,،|]/)
    .map((p) => p.trim())
    .filter(Boolean)

  if (parts.length === 1) return { city: parts[0], neighborhood: null, street: null }

  const city = parts[parts.length - 1]
  if (parts.length === 2) {
    const looksLikeStreet = /\d/.test(parts[0])
    return { city, neighborhood: looksLikeStreet ? null : parts[0], street: looksLikeStreet ? parts[0] : null }
  }
  return { city, neighborhood: parts[parts.length - 2], street: parts.slice(0, parts.length - 2).join(', ') }
}

function resolveSourceUrl(item: Yad2Item): string | null {
  const url = cleanString(item.item_url)
  if (url) return url
  const itemId = cleanString(item.item_id)
  return itemId ? `https://www.yad2.co.il/realestate/item/${encodeURIComponent(itemId)}` : null
}

export function mapYad2Item(item: Yad2Item): PropertyInput {
  const location = parseLocation(item.location)
  const description = cleanString(item.description)
  const availableFrom = toEntranceDate(item.entrance_date)

  return {
    // Only set when present so a re-import never blanks out existing text or dates.
    ...(description ? { description } : {}),
    ...(availableFrom ? { available_from: availableFrom } : {}),
    balcony: toBoolean(item.balcony),
    furnished: toBoolean(item.furnished),
    garden: toBoolean(item.garden),
    source: 'yad2',
    transaction_type: 'rent',
    property_type: 'apartment',
    source_url: resolveSourceUrl(item),
    price: toNumber(item.price),
    rooms: toNumber(item.rooms),
    surface_m2: toNumber(item.square_meter),
    floor: toFloor(item.floor),
    parking: toBoolean(item.parking),
    elevator: toBoolean(item.elevator),
    mamad: toBoolean(item.safe_room),
    city: location.city,
    neighborhood: location.neighborhood,
    street: location.street,
    ...inferCondition(item.property_condition),
  }
}
