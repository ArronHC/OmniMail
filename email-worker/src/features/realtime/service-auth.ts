import type { Env } from '../../app/types'
import { bounded, realtimeEnabled } from './types'

const encoder = new TextEncoder()
type ServiceKey = { deviceId: string; secret: string; notAfter?: number }
export function signatureInput(method: string, path: string, timestamp: string, nonce: string, body: string) {
  return ['omnimail-realtime-v1', method.toUpperCase(), path, timestamp, nonce, body].join('\n')
}
export async function signServiceRequest(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function authenticateService(request: Request, env: Env, body: string, now = Date.now()) {
  if (!realtimeEnabled(env) || new URL(request.url).protocol !== 'https:') return null
  // Browser requests and query strings are not supported for device endpoints.
  if (request.headers.has('Origin') || new URL(request.url).search || body.length > 16_384) return null
  const keyId = request.headers.get('X-Omni-Key') || ''
  const timestamp = request.headers.get('X-Omni-Time') || ''
  const nonce = request.headers.get('X-Omni-Nonce') || ''
  const signature = request.headers.get('X-Omni-Signature') || ''
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) || !/^\d{13}$/.test(timestamp)
    || Math.abs(now - Number(timestamp)) > 60_000 || !/^[a-zA-Z0-9_-]{22,80}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signature)) return null
  let keys: Record<string, ServiceKey>
  try { keys = JSON.parse(env.REALTIME_SERVICE_KEYS || '{}') }
  catch { return null }
  const entry = keys[keyId]
  if (!entry || typeof entry.secret !== 'string' || encoder.encode(entry.secret).length < 32
    || typeof entry.deviceId !== 'string' || entry.notAfter !== undefined && (!Number.isSafeInteger(entry.notAfter) || entry.notAfter <= now)) return null
  const key = await crypto.subtle.importKey('raw', encoder.encode(entry.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const signed = signatureInput(request.method, new URL(request.url).pathname, timestamp, nonce, body)
  const bytes = Uint8Array.from(signature.match(/../g)!, (part) => parseInt(part, 16))
  if (!await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(signed))) return null
  const seconds = Math.floor(now / 1000)
  const limit = bounded(env.REALTIME_DEVICE_REQUESTS_PER_MINUTE, 120, 10, 1000)
  const day = Math.floor(now / 86_400_000)
  const dailyLimit = bounded(env.REALTIME_DEVICE_REQUESTS_PER_DAY, 10_000, 100, 200_000)
  const claim = await env.DB.prepare(
    `UPDATE realtime_devices SET last_seen_at = ?,
       daily_requests = CASE WHEN request_day != ? THEN 1 ELSE daily_requests + 1 END,
       request_day = ?,
       request_count = CASE WHEN window_at <= ? THEN 1 ELSE request_count + 1 END,
       window_at = CASE WHEN window_at <= ? THEN ? ELSE window_at END
     WHERE id = ? AND enabled = 1 AND (window_at <= ? OR request_count < ?)
       AND (request_day != ? OR daily_requests < ?)`,
  ).bind(seconds, day, day, seconds - 60, seconds - 60, seconds, entry.deviceId, seconds - 60, limit, day, dailyLimit).run()
  if (!claim.meta.changes) return null
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO realtime_nonces(device_id, nonce, expires_at) VALUES (?, ?, ?)',
  ).bind(entry.deviceId, nonce, seconds + 120).run()
  return inserted.meta.changes ? entry.deviceId : null
}
