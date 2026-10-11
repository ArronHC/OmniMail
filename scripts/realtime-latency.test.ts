import { describe, expect, it } from 'vitest'
// @ts-expect-error Standalone operator tool is JavaScript.
import { latencyReport } from './realtime-latency.mjs'

describe('real mail latency reporting', () => {
  const sample = {id:'a',source:'real',arrivedAt:1000,detectedAt:1100,receivedAt:1200,indexedAt:1400,clientDiscoveredAt:1500,visibleAt:1600}
  it('computes nearest-rank percentiles including actual visibility', () => {
    const rows = [sample,{...sample,id:'b',visibleAt:2000},{...sample,id:'c',visibleAt:12000}]
    expect(latencyReport(rows).metricsMs.endToEnd).toEqual({p50:1000,p95:11000,p99:11000})
    expect(latencyReport(rows).within10Seconds).toBe(2)
  })
  it('rejects duplicate samples, missing arrival and impossible clock ordering', () => {
    expect(() => latencyReport([sample,sample])).toThrow('Unique')
    expect(() => latencyReport([{...sample,arrivedAt:undefined}])).toThrow('Missing')
    expect(() => latencyReport([{...sample,receivedAt:900}])).toThrow('Non-monotonic')
  })
  it('keeps empty real measurements empty rather than fabricating a percentile', () => {
    expect(latencyReport([])).toMatchObject({samples:0,real:0,metricsMs:{endToEnd:{p50:null,p95:null,p99:null}}})
  })
})
