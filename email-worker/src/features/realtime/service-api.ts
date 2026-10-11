import type { Env } from '../../app/types'
import { authenticateService } from './service-auth'
import { validSubscription } from './types'
import { credentialVersion, deviceCredential } from './credentials'
import { receiveRealtimeEvent } from './jobs'

async function limitedBody(request: Request) {
  if (!request.body) return ''
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.length
      if (bytes > 16384) { await reader.cancel(); throw new Error('Body too large') }
      parts.push(part.value)
    }
    const output = new Uint8Array(bytes); let offset = 0
    for (const part of parts) { output.set(part, offset); offset += part.length }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output)
  } finally { reader.releaseLock() }
}
export async function realtimeServiceApi(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  try {
    const body = await limitedBody(request)
    const deviceId = await authenticateService(request, env, body)
    if (!deviceId) return json({ error: 'Service authentication failed' }, 401)
    const path = new URL(request.url).pathname
    if (path === '/api/internal/realtime/manifest' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT id FROM realtime_subscriptions WHERE device_id = ? AND enabled = 1 ORDER BY id LIMIT 100')
        .bind(deviceId).all<{ id: string }>()
      const accounts = []
      for (const row of results) {
        const subscription = await validSubscription(env, row.id, deviceId)
        if (subscription) accounts.push({ id: subscription.id, provider: subscription.provider,
          generation: subscription.generation, version: await credentialVersion(env, subscription) })
      }
      return json({ accounts, refreshAfterSeconds: 60, serverTime: Date.now() })
    }
    let payload: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(body || '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value)) return json({ error: 'Invalid JSON object' }, 400)
      payload = value as Record<string, unknown>
    } catch { return json({ error: 'Invalid JSON' }, 400) }
    if (typeof payload.subscriptionId !== 'string' || payload.subscriptionId.length > 80) return json({ error: 'Invalid account' }, 400)
    const subscription = await validSubscription(env, payload.subscriptionId, deviceId)
    if (!subscription || payload.generation !== subscription.generation) return json({ error: 'Authorization revoked' }, 403)
    if (path === '/api/internal/realtime/credentials' && request.method === 'POST') {
      return json(await deviceCredential(env, subscription))
    }
    if (path === '/api/internal/realtime/events' && request.method === 'POST') {
      if (!['exists', 'reconnected', 'fallback'].includes(String(payload.type))
        || !Number.isSafeInteger(payload.detectedAt) || Number(payload.detectedAt) > Date.now() + 60_000
        || Number(payload.detectedAt) < Date.now() - 3600_000) return json({ error: 'Invalid event' }, 400)
      const queued = await receiveRealtimeEvent(env, subscription.id, Number(payload.detectedAt))
      // Queue execution has a longer lifetime than HTTP waitUntil; never hold an
      // account lease in a task that may be cancelled 30 seconds after this response.
      return json({ accepted: true, coalesced: !queued }, 202)
    }
    if (path === '/api/internal/realtime/status' && request.method === 'POST') {
      if (!['idle', 'fallback', 'connecting', 'backoff', 'authentication_failed'].includes(String(payload.state))) return json({ error: 'Invalid state' }, 400)
      await env.DB.prepare('UPDATE realtime_subscriptions SET listener_state = ?, last_error = ? WHERE id = ?')
        .bind(payload.state, payload.state === 'authentication_failed' ? 'authentication_failed' : '', subscription.id).run()
      return json({ ok: true })
    }
    return json({ error: 'Unknown endpoint' }, 404)
  } catch { return json({ error: 'Realtime request could not be completed' }, 503) }
}
