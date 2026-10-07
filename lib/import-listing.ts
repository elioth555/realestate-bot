const STRING_FIELDS = [
  'title',
  'city',
  'neighborhood',
  'street',
  'phone',
  'source',
  'source_url',
  'description',
  'property_type',
] as const

const NUMBER_FIELDS = ['price', 'rooms', 'surface_m2', 'floor', 'bathrooms', 'toilets'] as const

const BOOLEAN_FIELDS = [
  'parking',
  'mamad',
  'balcony',
  'elevator',
  'furnished',
  'terrace',
  'garden',
  'pool',
  'gym',
  'sea_view',
  'renovated',
  'new_building',
  'pet_friendly',
] as const

const DATE_FIELDS = ['published_at', 'available_from'] as const

const TRANSACTION_TYPES = ['rent', 'sale'] as const

const REQUIRED_FIELDS = ['source_url', 'transaction_type', 'city', 'price'] as const

// Facebook posts often omit the price (and sometimes the city) in the initial post; keep them instead of dropping.
const FACEBOOK_REQUIRED_FIELDS = ['source', 'source_url', 'transaction_type', 'description'] as const

export function requiredFieldsFor(source: unknown): readonly string[] {
  return typeof source === 'string' && source.trim().toLowerCase() === 'facebook'
    ? FACEBOOK_REQUIRED_FIELDS
    : REQUIRED_FIELDS
}

export const SUPPORTED_FIELDS = [
  ...STRING_FIELDS,
  ...NUMBER_FIELDS,
  ...BOOLEAN_FIELDS,
  ...DATE_FIELDS,
  'transaction_type',
] as const

export type PropertyInput = Partial<Record<(typeof SUPPORTED_FIELDS)[number], string | number | boolean | null>>

type ValidationResult = { ok: true; data: PropertyInput & { source_url: string } } | { ok: false; errors: string[] }

function isBlank(value: unknown) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function parseNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/[,\s₪]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function parseBoolean(value: unknown) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  return null
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function validatePropertyInput(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['Request body must be a JSON object describing one property.'] }
  }

  const input = body as Record<string, unknown>
  const errors: string[] = []
  const data: PropertyInput = {}

  for (const field of requiredFieldsFor(input.source)) {
    if (isBlank(input[field])) errors.push(`"${field}" is required.`)
  }

  const unknownFields = Object.keys(input).filter((key) => !(SUPPORTED_FIELDS as readonly string[]).includes(key))
  if (unknownFields.length > 0) {
    errors.push(`Unsupported field(s): ${unknownFields.map((f) => `"${f}"`).join(', ')}.`)
  }

  for (const field of STRING_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    if (value === null) {
      data[field] = null
    } else if (typeof value === 'string') {
      data[field] = value.trim()
    } else {
      errors.push(`"${field}" must be a string.`)
    }
  }

  for (const field of NUMBER_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    if (value === null) {
      data[field] = null
      continue
    }
    const n = parseNumber(value)
    if (n === null) errors.push(`"${field}" must be a number.`)
    else if (n < 0 && field !== 'floor') errors.push(`"${field}" cannot be negative.`)
    else data[field] = n
  }

  for (const field of BOOLEAN_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    if (value === null) {
      data[field] = null
      continue
    }
    const b = parseBoolean(value)
    if (b === null) errors.push(`"${field}" must be true or false.`)
    else data[field] = b
  }

  for (const field of DATE_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    if (value === null) {
      data[field] = null
      continue
    }
    if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
      errors.push(`"${field}" must be an ISO date string (e.g. 2026-09-30 or 2026-09-30T10:00:00Z).`)
    } else {
      data[field] = value
    }
  }

  const transactionType = input.transaction_type
  if (!isBlank(transactionType)) {
    const normalized = typeof transactionType === 'string' ? transactionType.trim().toLowerCase() : ''
    if ((TRANSACTION_TYPES as readonly string[]).includes(normalized)) {
      data.transaction_type = normalized
    } else {
      errors.push(`"transaction_type" must be one of: ${TRANSACTION_TYPES.join(', ')}.`)
    }
  }

  if (typeof data.source_url === 'string' && data.source_url && !isHttpUrl(data.source_url)) {
    errors.push('"source_url" must be a valid http(s) URL.')
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, data: data as PropertyInput & { source_url: string } }
}
