const STORE_ID_PATTERN = /^[A-Za-z0-9_~-]+$/

export function extractKeyValueStoreId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const body = payload as Record<string, unknown>
  const resource = (body.resource && typeof body.resource === 'object' ? body.resource : {}) as Record<string, unknown>
  const id = resource.defaultKeyValueStoreId ?? body.defaultKeyValueStoreId
  return typeof id === 'string' && STORE_ID_PATTERN.test(id.trim()) ? id.trim() : null
}

/**
 * The INPUT a run was started with (read-only). Returns null instead of throwing: the import must still
 * run without it; the refresh run just isn't recorded, so it can never age a listing.
 */
export async function fetchRunInputSafe(keyValueStoreId: string | null, token: string): Promise<unknown> {
  if (!keyValueStoreId) return null
  try {
    const res = await fetch(
      `https://api.apify.com/v2/key-value-stores/${encodeURIComponent(keyValueStoreId)}/records/INPUT`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, cache: 'no-store' },
    )
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}
