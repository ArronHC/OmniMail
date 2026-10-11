import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function latencyReport(records) {
  const stages = ['arrivedAt','detectedAt','receivedAt','indexedAt','clientDiscoveredAt','visibleAt']
  const metrics = Object.fromEntries(['endToEnd','discovery','transport','indexing','clientSignal','render'].map((key) => [key, []]))
  const seen = new Set()
  for (const row of records) {
    if (!row.id || seen.has(row.id)) throw Error('Unique sample id required')
    seen.add(row.id)
    if (row.source !== 'real' && row.source !== 'mock') throw Error('Each sample must declare real or mock')
    if (stages.some((key) => !Number.isSafeInteger(row[key]) || row[key] <= 0)) throw Error(`Missing timestamp: ${row.id}`)
    if (stages.some((key,i) => i && row[key] < row[stages[i-1]])) throw Error(`Non-monotonic clocks: ${row.id}`)
    const values = [row.visibleAt-row.arrivedAt,row.detectedAt-row.arrivedAt,row.receivedAt-row.detectedAt,row.indexedAt-row.receivedAt,row.clientDiscoveredAt-row.indexedAt,row.visibleAt-row.clientDiscoveredAt]
    Object.keys(metrics).forEach((key,i) => metrics[key].push(values[i]))
  }
  const percentile = (values,p) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1] : null
  return { samples: records.length, real: records.filter((r) => r.source==='real').length, mock: records.filter((r) => r.source==='mock').length,
    correlation: 'Account batch timestamps; unique mail arrival and visible times. See VALIDATION.md.',
    metricsMs: Object.fromEntries(Object.entries(metrics).map(([key,values]) => [key,{p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99)}])),
    within10Seconds: metrics.endToEnd.filter((n) => n<=10000).length }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw Error('Usage: node scripts/realtime-latency.mjs measurements.jsonl')
  const rows = readFileSync(process.argv[2],'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  if (rows.some((row) => !['real','mock'].includes(row.source))) throw Error('Every sample must declare real or mock')
  // Do not aggregate real and synthetic observations into the same percentile.
  console.log(JSON.stringify(Object.fromEntries(['real','mock'].map((source) => [source,latencyReport(rows.filter((row) => row.source===source))])),null,2))
}
