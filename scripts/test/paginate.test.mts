import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllPages, type PageResult } from '../../lib/paginate.ts'

type Row = { id: number }

function table(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: count - i }))
}

function pager(rows: Row[]) {
  const calls: [number, number][] = []
  const fetchPage = async (from: number, to: number): Promise<PageResult<Row>> => {
    calls.push([from, to])
    return { data: rows.slice(from, to + 1), error: null }
  }
  return { fetchPage, calls }
}

const opts = { pageSize: 1000, maxPages: 50, keyOf: (r: unknown) => String((r as Row).id) }

test('fewer than one page: single request', async () => {
  const { fetchPage, calls } = pager(table(437))
  const res = await fetchAllPages(fetchPage, opts)
  assert.equal(res.rows.length, 437)
  assert.deepEqual(calls, [[0, 999]])
})

test('exactly 1,000 rows: second request returns empty and stops', async () => {
  const { fetchPage, calls } = pager(table(1000))
  const res = await fetchAllPages(fetchPage, opts)
  assert.equal(res.rows.length, 1000)
  assert.deepEqual(calls, [[0, 999], [1000, 1999]])
})

test('more than 1,000 rows (1,084): all loaded in order', async () => {
  const rows = table(1084)
  const { fetchPage, calls } = pager(rows)
  const res = await fetchAllPages(fetchPage, opts)
  assert.equal(res.rows.length, 1084)
  assert.deepEqual(res.rows, rows)
  assert.equal(calls.length, 2)
})

test('multiple pages with smaller page size', async () => {
  const rows = table(2350)
  const { fetchPage, calls } = pager(rows)
  const res = await fetchAllPages(fetchPage, { ...opts, pageSize: 500 })
  assert.equal(res.rows.length, 2350)
  assert.deepEqual(res.rows, rows)
  assert.deepEqual(calls.map((c) => c[0]), [0, 500, 1000, 1500, 2000])
})

test('empty final page ends the loop', async () => {
  const { fetchPage, calls } = pager(table(1500))
  const res = await fetchAllPages(fetchPage, { ...opts, pageSize: 500 })
  assert.equal(res.rows.length, 1500)
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.at(-1), [1500, 1999])
})

test('empty table', async () => {
  const { fetchPage } = pager([])
  const res = await fetchAllPages(fetchPage, opts)
  assert.deepEqual(res.rows, [])
  assert.equal(res.error, null)
})

test('no duplicates when a row shifts across a page boundary', async () => {
  // Page 2 re-returns the last row of page 1, as happens if a new row is inserted mid-read.
  const pages: Row[][] = [[{ id: 5 }, { id: 4 }, { id: 3 }], [{ id: 3 }, { id: 2 }]]
  let i = 0
  const res = await fetchAllPages<Row>(async () => ({ data: pages[i++] ?? [], error: null }), { ...opts, pageSize: 3 })
  assert.deepEqual(res.rows.map((r) => r.id), [5, 4, 3, 2])
})

test('every id appears exactly once across many pages', async () => {
  const { fetchPage } = pager(table(3001))
  const res = await fetchAllPages(fetchPage, { ...opts, pageSize: 250 })
  assert.equal(new Set(res.rows.map((r) => r.id)).size, 3001)
})

test('error on a later page is returned with rows loaded so far', async () => {
  let i = 0
  const res = await fetchAllPages<Row>(
    async () => (i++ === 0 ? { data: table(2), error: null } : { data: null, error: { message: 'boom' } }),
    { ...opts, pageSize: 2 },
  )
  assert.equal(res.error?.message, 'boom')
  assert.equal(res.rows.length, 2)
})

test('maxPages caps a backend that never returns a short page', async () => {
  let calls = 0
  const res = await fetchAllPages<Row>(
    async (from) => {
      calls++
      return { data: [{ id: from }, { id: from + 1 }], error: null }
    },
    { ...opts, pageSize: 2, maxPages: 3 },
  )
  assert.equal(calls, 3)
  assert.equal(res.rows.length, 6)
})
