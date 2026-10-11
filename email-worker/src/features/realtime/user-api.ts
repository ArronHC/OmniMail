import { Hono } from 'hono'
import type { AppContext } from '../../app/context'
import { bounded, PROVIDERS, provider, realtimeEnabled, validSubscription } from './types'
import { publicDeviceKey } from './credentials'
import { receiveRealtimeEvent } from './jobs'

export const realtimeRoutes = new Hono<AppContext>()
realtimeRoutes.use('*', async (c, next) => {
  if (!realtimeEnabled(c.env)) return c.json({ enabled: false, error: 'Realtime sync is disabled' }, 404)
  c.header('Cache-Control', 'no-store')
  await next()
})
realtimeRoutes.get('/config', async (c) => {
  const settings = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'realtime_enabled'").first<{ value: string }>()
  return c.json({ enabled: settings?.value === '1' })
})
realtimeRoutes.get('/updates', async (c) => {
  if (!c.env.REALTIME_UPDATES) return c.json({ error: 'Updates binding unavailable' }, 503)
  const stub = c.env.REALTIME_UPDATES.get(c.env.REALTIME_UPDATES.idFromName(c.get('user').id))
  return stub.fetch(c.req.raw)
})
realtimeRoutes.get('/devices', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, enabled, last_seen_at FROM realtime_devices ORDER BY created_at LIMIT 100').all()
  return c.json({ devices: results })
})
realtimeRoutes.get('/subscriptions', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT s.*, d.last_seen_at AS device_last_seen_at FROM realtime_subscriptions s JOIN realtime_devices d ON d.id=s.device_id WHERE s.user_id = ? ORDER BY s.id')
    .bind(c.get('user').id).all()
  return c.json({ subscriptions: results })
})
realtimeRoutes.post('/subscriptions/:id/action', async (c) => {
  const user = c.get('user'); const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT user_id, enabled FROM realtime_subscriptions WHERE id = ?')
    .bind(id).first<{ user_id: string; enabled: number }>()
  if (!row || row.user_id !== user.id && user.role !== 'super_admin') return c.json({ error: 'Subscription unavailable' }, 404)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (body?.type === 'disable') {
    await c.env.DB.prepare('UPDATE realtime_subscriptions SET enabled=0, generation=generation+1 WHERE id=?').bind(id).run()
    return c.json({ ok: true })
  }
  if (!['reconnect', 'sync'].includes(String(body?.type))) return c.json({ error: 'Invalid action' }, 400)
  const claimed = await c.env.DB.prepare('UPDATE realtime_subscriptions SET last_action_at=? WHERE id=? AND last_action_at<=?')
    .bind(Date.now(), id, Date.now()-30_000).run()
  if (!claimed.meta.changes) return c.json({ error: 'Wait 30 seconds before another action' }, 429)
  if (!row.enabled) return c.json({ error: 'Subscription is disabled' }, 409)
  if (body?.type === 'reconnect') {
    await c.env.DB.prepare('UPDATE realtime_subscriptions SET generation=generation+1 WHERE id=?').bind(id).run()
    return c.json({ ok: true })
  }
  if (body?.type === 'sync') {
    if (!await validSubscription(c.env, id)) return c.json({ error: 'Authorization unavailable' }, 403)
    await receiveRealtimeEvent(c.env, id, Date.now())
    return c.json({ queued: true }, 202)
  }
  return c.json({ error: 'Invalid action' }, 400)
})
realtimeRoutes.put('/subscriptions', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || !provider(body.provider) || typeof body.accountId !== 'string'
    || typeof body.deviceId !== 'string' || typeof body.enabled !== 'boolean'
    || body.accountId.length > 80 || body.deviceId.length > 64) return c.json({ error: 'Invalid authorization' }, 400)
  const user = c.get('user')
  if (user.role === 'temporary') return c.json({ error: 'Temporary accounts cannot authorize credentials' }, 403)
  const account = await c.env.DB.prepare(`SELECT id FROM ${PROVIDERS[body.provider].table} WHERE id = ? AND user_id = ?`)
    .bind(body.accountId, user.id).first()
  const device = await c.env.DB.prepare('SELECT id FROM realtime_devices WHERE id = ? AND enabled = 1')
    .bind(body.deviceId).first()
  if (!account || !device) return c.json({ error: 'Account or device unavailable' }, 404)
  const limit = bounded(c.env.REALTIME_MAX_SUBSCRIPTIONS, 50, 1, 100)
  const existing = await c.env.DB.prepare('SELECT id, enabled FROM realtime_subscriptions WHERE provider = ? AND account_id = ? AND user_id = ?')
    .bind(body.provider, body.accountId, user.id).first<{ id: string; enabled: number }>()
  const inserted = await c.env.DB.prepare(`INSERT INTO realtime_subscriptions(id, user_id, provider, account_id, device_id, enabled, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE ?=0 OR EXISTS (
      SELECT 1 FROM realtime_subscriptions WHERE id=? AND enabled=1
    ) OR (SELECT COUNT(*) FROM realtime_subscriptions WHERE enabled=1) < ? ON CONFLICT(provider, account_id) DO UPDATE SET
    device_id = excluded.device_id, enabled = excluded.enabled, generation = generation + 1,
    listener_state = 'offline', updated_at = excluded.updated_at WHERE user_id = excluded.user_id`)
    .bind(existing?.id || crypto.randomUUID(), user.id, body.provider, body.accountId, body.deviceId, Number(body.enabled), Math.floor(Date.now() / 1000), Number(body.enabled), existing?.id || "", limit).run()
  if (!inserted.meta.changes) return c.json({ error: 'Realtime capacity limit reached' }, 429)
  return c.json({ ok: true })
})
realtimeRoutes.use('/admin/*', async (c, next) => {
  if (c.get('user').role !== 'super_admin') return c.json({ error: 'Owner permission required' }, 403)
  await next()
})
realtimeRoutes.put('/admin/config', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid setting' }, 400)
  await c.env.DB.prepare("INSERT INTO settings(key, value) VALUES('realtime_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(body.enabled ? '1' : '0').run()
  return c.json({ ok: true })
})
realtimeRoutes.put('/admin/devices/:id', async (c) => {
  const id = c.req.param('id'); const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !body || typeof body.name !== 'string'
    || body.name.length < 1 || body.name.length > 80 || typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid device' }, 400)
  try { await publicDeviceKey(body.publicKey) } catch { return c.json({ error: 'RSA public key >=2048 bits required' }, 400) }
  const key = JSON.stringify(body.publicKey)
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE realtime_subscriptions SET enabled=0,generation=generation+1
      WHERE device_id=? AND EXISTS (SELECT 1 FROM realtime_devices WHERE id=? AND public_key!=?)`)
      .bind(id, id, key),
    c.env.DB.prepare(`INSERT INTO realtime_devices(id, name, public_key, enabled, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name,
    public_key = excluded.public_key, enabled = excluded.enabled`)
    .bind(id, body.name, key, Number(body.enabled), Math.floor(Date.now() / 1000)),
  ])
  return c.json({ ok: true })
})
realtimeRoutes.patch('/admin/devices/:id', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (typeof body?.enabled !== 'boolean') return c.json({ error: 'Invalid setting' }, 400)
  await c.env.DB.prepare('UPDATE realtime_devices SET enabled=? WHERE id=?').bind(Number(body.enabled), c.req.param('id')).run()
  return c.json({ ok: true })
})
realtimeRoutes.get('/admin/status', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT s.*, d.last_seen_at AS device_last_seen_at,
    j.requested_seq, j.completed_seq, j.attempts, j.lease_until
    FROM realtime_subscriptions s JOIN realtime_devices d ON d.id = s.device_id
    LEFT JOIN realtime_jobs j ON j.subscription_id = s.id ORDER BY s.id LIMIT 100`).all()
  const { results: measurements } = await c.env.DB.prepare('SELECT * FROM realtime_measurements ORDER BY created_at DESC LIMIT 1000').all()
  return c.json({ subscriptions: results, measurements })
})
