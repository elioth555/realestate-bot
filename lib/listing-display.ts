import { formatPrice } from './filters'
import type { Listing } from './listings'

export const PRICE_NOT_STATED = 'Price not stated'

/** Never renders ₪0: unknown or zero prices read as "Price not stated". */
export function displayPrice(listing: Pick<Listing, 'price' | 'known'>) {
  return listing.known.price && listing.price > 0 ? formatPrice(listing.price) : PRICE_NOT_STATED
}

export function displayRooms(listing: Pick<Listing, 'rooms' | 'known'>) {
  return listing.known.rooms ? String(listing.rooms) : '—'
}

export function displaySurface(listing: Pick<Listing, 'surface' | 'known'>) {
  return listing.known.surface ? `${listing.surface} m²` : '—'
}

export function displayFloor(floor: number | null) {
  if (floor === null) return '—'
  return floor === 0 ? 'Ground' : String(floor)
}

function phoneDigits(phone: string) {
  let digits = phone.replace(/\D/g, '')
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`
  return digits
}

/** 0541234567 → 054-123-4567, 031234567 → 03-123-4567. Returns '' when the value is not an Israeli number. */
export function formatIsraeliPhone(phone: string) {
  const digits = phoneDigits(phone)
  if (/^0[57]\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  if (/^0[2-489]\d{7}$/.test(digits)) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`
  return ''
}

export function phoneHref(phone: string) {
  const digits = phoneDigits(phone)
  return digits.startsWith('0') ? `tel:+972${digits.slice(1)}` : `tel:${digits}`
}

/** A display phone: normalized Israeli format when possible, otherwise the stored value as-is (never invented). */
export function displayPhone(phone: string) {
  return formatIsraeliPhone(phone) || phone.trim()
}

export function formatPublishedDate(iso: string | null) {
  if (!iso) return null
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}
