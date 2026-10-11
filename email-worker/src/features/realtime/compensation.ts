import type { Env } from '../../app/types'
import { bounded, PROVIDERS, type Provider, realtimeEnabled } from './types'

export async function extendRealtimeCompensation(env: Env, provider: Provider, accountId: string, now: number) {
  if (!realtimeEnabled(env)) return
  const seconds = bounded(env.REALTIME_COMPENSATION_SECONDS, 1800, 300, 86400)
  await env.DB.prepare(`UPDATE ${PROVIDERS[provider].table} SET next_sync_at = MAX(next_sync_at, ?)
    WHERE id = ? AND EXISTS (
      SELECT 1 FROM realtime_subscriptions s JOIN realtime_devices d ON d.id = s.device_id
      JOIN settings config ON config.key = 'realtime_enabled' AND config.value = '1'
      WHERE s.provider = ? AND s.account_id = ? AND s.enabled = 1
        AND s.listener_state = 'idle' AND d.enabled = 1 AND d.last_seen_at >= ?
    )`).bind(now + seconds, accountId, provider, accountId, now - 120).run()
}
export async function restoreOfflineCompensation(env: Env, now: number) {
  // Old deployments without the optional migration must remain usable.
  if (!realtimeEnabled(env) && !await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='realtime_subscriptions'").first()) return
  const { results } = await env.DB.prepare(`SELECT s.provider, s.account_id FROM realtime_subscriptions s
    JOIN realtime_devices d ON d.id = s.device_id
    WHERE ?=0 OR s.enabled = 0 OR d.enabled = 0 OR d.last_seen_at IS NULL OR d.last_seen_at < ?
      OR s.listener_state != 'idle' OR NOT EXISTS (
        SELECT 1 FROM settings WHERE key='realtime_enabled' AND value='1'
      ) LIMIT 100`).bind(Number(realtimeEnabled(env)), now - 120).all<{ provider: Provider; account_id: string }>()
  for (const row of results) await env.DB.prepare(`UPDATE ${PROVIDERS[row.provider].table}
    SET next_sync_at = ? WHERE id = ? AND next_sync_at > ?`).bind(now, row.account_id, now + 300).run()
}

export async function publishCompensatedIndex(env: Env, provider: Provider, accountId: string) {
  if (!realtimeEnabled(env) || !env.REALTIME_UPDATES) return
  const row = await env.DB.prepare(`SELECT s.user_id FROM realtime_subscriptions s
    JOIN users u ON u.id=s.user_id AND u.status='active' AND u.deleted_at IS NULL
    WHERE s.provider=? AND s.account_id=? AND s.enabled=1
      AND EXISTS (SELECT 1 FROM settings WHERE key='realtime_enabled' AND value='1')`).bind(provider, accountId).first<{user_id: string}>()
  if (!row) return
  await env.REALTIME_UPDATES.get(env.REALTIME_UPDATES.idFromName(row.user_id)).fetch('https://updates.internal/publish', {
    method: 'POST', body: JSON.stringify({type: 'indexed', provider, accountId, indexedAt: Date.now()})
  }).catch(() => undefined)
}
