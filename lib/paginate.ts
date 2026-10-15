export type PageResult<T> = { data: T[] | null; error: { message: string } | null }

export type FetchAllPagesOptions = {
  pageSize: number
  /** Hard stop so a misbehaving backend can never loop forever. */
  maxPages: number
  /** Rows sharing a key are kept once (first occurrence wins), guarding against page-boundary shifts. */
  keyOf?: (row: unknown) => string
}

/**
 * Loads every row by requesting consecutive inclusive ranges until a page comes back short.
 * Order is whatever `fetchPage` applies; pages are concatenated in request order.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  { pageSize, maxPages, keyOf }: FetchAllPagesOptions,
): Promise<{ rows: T[]; error: { message: string } | null; pages: number }> {
  const rows: T[] = []
  const seen = new Set<string>()
  let pages = 0

  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    pages++
    if (error) return { rows, error, pages }

    const batch = data ?? []
    for (const row of batch) {
      if (keyOf) {
        const key = keyOf(row)
        if (seen.has(key)) continue
        seen.add(key)
      }
      rows.push(row)
    }
    if (batch.length < pageSize) break
  }

  return { rows, error: null, pages }
}
