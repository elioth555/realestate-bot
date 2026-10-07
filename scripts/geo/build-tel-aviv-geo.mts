/**
 * Regenerates the static Tel Aviv geography snapshot from the municipality's public ArcGIS service.
 *
 *   node scripts/geo/build-tel-aviv-geo.mts
 *
 * Layer 511 = official neighborhood polygons (שכונות), layer 527 = every address point (כתובות).
 * About 30 sequential requests with a pause between them; run it rarely (the data changes slowly).
 * Output stores municipal neighborhood numbers only; the mapping to dashboard zones lives in code.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://gisn.tel-aviv.gov.il/arcgis/rest/services/IView2/MapServer'
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../lib/geo/data')
const PAGE = 2000
const PAUSE_MS = 400

type Ring = [number, number][]
type Polygon = { ms: number; name: string; bbox: [number, number, number, number]; rings: Ring[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function query(layer: number, params: Record<string, string>) {
  const url = `${BASE}/${layer}/query?${new URLSearchParams({ f: 'json', ...params })}`
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      const json = await res.json()
      if (!json.error) return json
    }
    await sleep(2000 * attempt)
  }
  throw new Error(`GIS query failed: layer ${layer}`)
}

function inRing(x: number, y: number, ring: Ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Even-odd across all rings handles holes without needing ring orientation.
function inPolygon(x: number, y: number, p: Polygon) {
  const [minX, minY, maxX, maxY] = p.bbox
  if (x < minX || x > maxX || y < minY || y > maxY) return false
  let inside = false
  for (const ring of p.rings) if (inRing(x, y, ring)) inside = !inside
  return inside
}

async function loadPolygons(): Promise<Polygon[]> {
  const json = await query(511, {
    where: '1=1',
    outFields: 'ms_shchuna,shem_shchuna',
    outSR: '4326',
    maxAllowableOffset: '0.00001',
    geometryPrecision: '6',
  })
  return json.features.map((f: { attributes: { ms_shchuna: number; shem_shchuna: string }; geometry: { rings: Ring[] } }) => {
    const pts = f.geometry.rings.flat()
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    return {
      ms: f.attributes.ms_shchuna,
      name: f.attributes.shem_shchuna.trim(),
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      rings: f.geometry.rings,
    }
  })
}

type Address = { code: number; he: string; en: string; num: number; lat: number; lon: number }

async function loadAddresses(): Promise<Address[]> {
  const out: Address[] = []
  for (let offset = 0; ; offset += PAGE) {
    const json = await query(527, {
      where: 'ms_bayit > 0',
      outFields: 'k_rechov,t_rechov,t_rechov_eng,ms_bayit,lat,lon',
      returnGeometry: 'false',
      orderByFields: 'oid_ktovet',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
    })
    for (const { attributes: a } of json.features) {
      if (!a.t_rechov || !a.ms_bayit || !a.lat || !a.lon) continue
      out.push({ code: a.k_rechov, he: a.t_rechov.trim(), en: (a.t_rechov_eng ?? '').trim(), num: a.ms_bayit, lat: a.lat, lon: a.lon })
    }
    process.stdout.write(`\raddresses ${out.length}`)
    if (json.features.length < PAGE) break
    await sleep(PAUSE_MS)
  }
  process.stdout.write('\n')
  return out
}

/** Collapses sorted house numbers of one parity into [from, to, ms] runs. */
function toRuns(entries: { num: number; ms: number }[]) {
  const sorted = [...entries].sort((a, b) => a.num - b.num)
  const runs: [number, number, number][] = []
  for (const { num, ms } of sorted) {
    const last = runs[runs.length - 1]
    if (last && last[2] === ms) last[1] = num
    else if (last && last[1] === num) continue // same number seen in two zones: keep the first
    else runs.push([num, num, ms])
  }
  return runs
}

const polygons = await loadPolygons()
console.log(`polygons ${polygons.length}`)
await sleep(PAUSE_MS)
const addresses = await loadAddresses()

const streets = new Map<number, { he: string; en: string; odd: { num: number; ms: number }[]; even: { num: number; ms: number }[] }>()
let unplaced = 0
for (const a of addresses) {
  const poly = polygons.find((p) => inPolygon(a.lon, a.lat, p))
  if (!poly) {
    unplaced++
    continue
  }
  const s = streets.get(a.code) ?? { he: a.he, en: a.en, odd: [], even: [] }
  ;(a.num % 2 ? s.odd : s.even).push({ num: a.num, ms: poly.ms })
  streets.set(a.code, s)
}
console.log(`streets ${streets.size}, addresses outside every polygon: ${unplaced}`)

mkdirSync(OUT_DIR, { recursive: true })
const generatedAt = new Date().toISOString().slice(0, 10)
const source = `${BASE} (layers 511, 527)`

writeFileSync(
  join(OUT_DIR, 'tel-aviv-neighborhoods.json'),
  JSON.stringify({ generatedAt, source, polygons }),
)
writeFileSync(
  join(OUT_DIR, 'tel-aviv-streets.json'),
  JSON.stringify({
    generatedAt,
    source,
    streets: [...streets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([code, s]) => ({ code, he: s.he, en: s.en, odd: toRuns(s.odd), even: toRuns(s.even) })),
  }),
)
console.log('written to', OUT_DIR)
