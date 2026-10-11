import type { Env } from '../../app/types'

// Per-execution counters use D1's reported row metadata; never persist SQL or values.
export function realtimeMetrics(env: Env) {
  const counts = { statements: 0, rowsRead: 0, rowsWritten: 0, queueWrites: 0 }
  const originals = new WeakMap<object, D1PreparedStatement>()
  const record = (result: unknown) => {
    const results = Array.isArray(result) ? result : [result]
    for (const item of results) {
      const meta = (item as { meta?: D1Meta } | null)?.meta
      if (meta) { counts.rowsRead += meta.rows_read || 0; counts.rowsWritten += meta.rows_written || 0 }
    }
  }
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values))
      if (property === 'first') return async (column?: string) => {
        counts.statements++
        const result = await target.all<Record<string, unknown>>()
        record(result)
        const row = result.results[0]
        if (column && row && !Object.hasOwn(row, column)) throw Error('D1 column unavailable')
        return column ? row?.[column] ?? null : row ?? null
      }
      const value = Reflect.get(target, property, target)
      if (property === 'all' || property === 'run') return async (...args: unknown[]) => {
        counts.statements++
        const result = await value.apply(target, args); record(result); return result
      }
      return typeof value === 'function' ? value.bind(target) : value
    } })
    originals.set(proxy, statement); return proxy
  }
  const DB = new Proxy(env.DB, { get(target, property) {
    if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql))
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      counts.statements += statements.length
      const result = await target.batch(statements.map((statement) => originals.get(statement) || statement))
      record(result); return result
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const MAIL_QUEUE = new Proxy(env.MAIL_QUEUE, { get(target, property) {
    const value = Reflect.get(target, property, target)
    if (property === 'send') return async (...args: unknown[]) => {
      await value.apply(target, args); counts.queueWrites++
    }
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { env: { ...env, DB, MAIL_QUEUE }, counts }
}
