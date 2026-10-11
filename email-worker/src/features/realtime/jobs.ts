import { realtimeMetrics } from './metrics'
import type { Env, MailQueueJob } from '../../app/types'
import { syncGmailAccount } from '../gmail/gmail-sync'
import { syncMicrosoftAccount } from '../microsoft/microsoft-sync'
import { syncQqMailAccount } from '../qq-mail/qq-mail-sync'
import { syncNaverMailAccount } from '../naver-mail/naver-mail-sync'
import { syncYandexMailAccount } from '../yandex-mail/yandex-mail-sync'
import { bounded, PROVIDERS, realtimeEnabled, validSubscription } from './types'

type Job = { requested_seq: number; completed_seq: number; detected_at: number; received_at: number }
export async function receiveRealtimeEvent(env: Env, id: string, detectedAt: number, now = Date.now()) {
  const minimum = bounded(env.REALTIME_ACCOUNT_MIN_INTERVAL_MS, 3000, 1000, 60_000)
  const accepted = await env.DB.prepare(
    `UPDATE realtime_subscriptions SET last_event_at = ?, updated_at = ?
     WHERE id = ? AND enabled = 1 AND (last_event_at IS NULL OR last_event_at <= ?)`,
  ).bind(now, Math.floor(now / 1000), id, now - minimum).run()
  // Always mark dirty, even when events are coalesced during a running sync.
  await env.DB.prepare(
    `INSERT INTO realtime_jobs(subscription_id, requested_seq, requested_at, detected_at, received_at)
     VALUES (?, 1, ?, ?, ?) ON CONFLICT(subscription_id) DO UPDATE SET
       requested_seq = requested_seq + 1, requested_at = excluded.requested_at,
       detected_at = CASE WHEN requested_seq = completed_seq THEN excluded.detected_at ELSE detected_at END,
       received_at = CASE WHEN requested_seq = completed_seq THEN excluded.received_at ELSE received_at END`,
  ).bind(id, now, detectedAt, now).run()
  const dispatch = await env.DB.prepare(`UPDATE realtime_jobs SET queued_until = ?
    WHERE subscription_id = ? AND lease_until <= ? AND queued_until <= ?`)
    .bind(now + 30_000, id, now, now).run()
  if (dispatch.meta.changes) {
    const job = await env.DB.prepare('SELECT next_attempt_at FROM realtime_jobs WHERE subscription_id = ?')
      .bind(id).first<{ next_attempt_at: number }>()
    try {
      const delaySeconds = Math.min(30, Math.max(0, Math.ceil(((job?.next_attempt_at || 0) - now) / 1000)))
      await env.MAIL_QUEUE.send({ kind: 'realtime-sync', subscriptionId: id }, { delaySeconds })
      console.info(JSON.stringify({ event: 'realtime_enqueued', subscriptionId: id, delaySeconds, queueWrites: 1 }))
    } catch (error) {
      await env.DB.prepare('UPDATE realtime_jobs SET queued_until=0 WHERE subscription_id=?').bind(id).run()
      throw error
    }
  }
  return Boolean(accepted.meta.changes)
}
async function executeRealtimeJob(env: Env, id: string): Promise<'done' | 'retry'> {
  if (!realtimeEnabled(env)) return 'done'
  const subscription = await validSubscription(env, id)
  if (!subscription) {
    await env.DB.prepare('DELETE FROM realtime_jobs WHERE subscription_id = ?').bind(id).run()
    return 'done'
  }
  const now = Date.now(); const leaseId = crypto.randomUUID()
  const day = Math.floor(now / 86_400_000)
  const budget = bounded(env.REALTIME_ACCOUNT_SYNCS_PER_DAY, 1000, 10, 10_000)
  const exhausted = await env.DB.prepare(`UPDATE realtime_jobs SET next_attempt_at=?
    WHERE subscription_id=? AND sync_day=? AND daily_syncs>=?`)
    .bind((day+1)*86_400_000, id, day, budget).run()
  if (exhausted.meta.changes) {
    await env.DB.prepare("UPDATE realtime_subscriptions SET last_error='daily_sync_budget' WHERE id=?").bind(id).run()
    return 'done' // Cron compensation remains independent of this event budget.
  }
  const claim = await env.DB.prepare(
    `UPDATE realtime_jobs SET lease_id = ?, lease_until = ?, queued_until = 0, attempts = attempts + 1,
       daily_syncs = CASE WHEN sync_day != ? THEN 1 ELSE daily_syncs + 1 END, sync_day = ?
     WHERE subscription_id = ? AND requested_seq > completed_seq
       AND lease_until <= ? AND next_attempt_at <= ?`,
  ).bind(leaseId, now + 420_000, day, day, id, now, now).run()
  if (!claim.meta.changes) {
    const job = await env.DB.prepare('SELECT requested_seq, completed_seq FROM realtime_jobs WHERE subscription_id = ?')
      .bind(id).first<Job>()
    return job && job.requested_seq > job.completed_seq ? 'retry' : 'done'
  }
  const job = await env.DB.prepare('SELECT * FROM realtime_jobs WHERE subscription_id = ? AND lease_id = ?')
    .bind(id, leaseId).first<Job>()
  if (!job) return 'done'
  try {
    const sync = subscription.provider === 'gmail' ? syncGmailAccount
      : subscription.provider === 'microsoft' ? syncMicrosoftAccount
      : subscription.provider === 'qq' ? syncQqMailAccount
      : subscription.provider === 'naver' ? syncNaverMailAccount : syncYandexMailAccount
    const result = subscription.provider === 'microsoft'
      ? await syncMicrosoftAccount(env, subscription.account_id, Math.floor(Date.now() / 1000), true)
      : await sync(env, subscription.account_id)
    if (result.status !== 'synced') {
      await env.DB.prepare(
        'UPDATE realtime_jobs SET lease_id = NULL, lease_until = 0, next_attempt_at = ? WHERE subscription_id = ? AND lease_id = ?',
      ).bind(Date.now() + (result.retryable ? 30_000 : 5000), id, leaseId).run()
      return 'retry'
    }
    const indexedAt = Date.now(); const measurementId = crypto.randomUUID()
    const duration = indexedAt - now
    await env.DB.batch([
      env.DB.prepare(`UPDATE realtime_jobs SET completed_seq = ?, lease_id = NULL, lease_until = 0,
        next_attempt_at = ?, attempts = 0 WHERE subscription_id = ? AND lease_id = ?`)
        .bind(job.requested_seq, indexedAt + bounded(env.REALTIME_ACCOUNT_MIN_INTERVAL_MS, 3000, 1000, 60_000), id, leaseId),
      env.DB.prepare(`UPDATE realtime_subscriptions SET last_sync_at = ?, last_duration_ms = ?, last_error = '' WHERE id = ?`)
        .bind(indexedAt, duration, id),
      env.DB.prepare(`INSERT INTO realtime_measurements(id, subscription_id, provider, detected_at,
        received_at, indexed_at, duration_ms, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', ?)`)
        .bind(measurementId, id, subscription.provider, job.detected_at, job.received_at, indexedAt, duration, Math.floor(indexedAt / 1000)),
    ])
    console.info(JSON.stringify({ event: 'realtime_indexed', subscriptionId: id, measurementId, provider: subscription.provider, detectedAt: job.detected_at, receivedAt: job.received_at, indexedAt, durationMs: duration }))
    // Recheck authorization after IMAP work; revoked accounts never broadcast to clients.
    if (await validSubscription(env, id) && env.REALTIME_UPDATES) {
      const stub = env.REALTIME_UPDATES.get(env.REALTIME_UPDATES.idFromName(subscription.user_id))
      try {
        const resp = await stub.fetch('https://updates.internal/publish', { method: 'POST', body: JSON.stringify({
          type: 'indexed', provider: subscription.provider, accountId: subscription.account_id,
          subscriptionId: id, measurementId, detectedAt: job.detected_at, receivedAt: job.received_at, indexedAt,
        }) })
        console.info(JSON.stringify({ event: 'realtime_published', subscriptionId: id, status: resp.status }))
      } catch (e) {
        console.error(JSON.stringify({ event: 'realtime_publish_failed', subscriptionId: id, error: String(e) }))
      }
    }
    const latest = await env.DB.prepare('SELECT requested_seq, completed_seq FROM realtime_jobs WHERE subscription_id = ?')
      .bind(id).first<Job>()
    return latest && latest.requested_seq > latest.completed_seq ? 'retry' : 'done'
  } catch {
    await env.DB.batch([
      env.DB.prepare('UPDATE realtime_jobs SET lease_id = NULL, lease_until = 0, next_attempt_at = ? WHERE subscription_id = ? AND lease_id = ?')
        .bind(Date.now() + 30_000, id, leaseId),
      env.DB.prepare("UPDATE realtime_subscriptions SET last_error = 'sync_failed' WHERE id = ?").bind(id),
    ])
    return 'retry'
  }
}
export async function consumeRealtimeJob(message: Message<MailQueueJob>, env: Env) {
  if (message.body.kind !== 'realtime-sync') return
  const outcome = await runRealtimeJob(env, message.body.subscriptionId)
  if (outcome === 'retry' && message.attempts < 3) message.retry({ delaySeconds: 5 * message.attempts })
  else message.ack() // Persisted pending work is recovered by Cron even after queue retries.
}
export async function recoverRealtimeJobs(env: Env) {
  if (!realtimeEnabled(env)) return
  const now = Date.now()
  // Provider account IDs cannot be polymorphic foreign keys; reclaim grants after
  // deletion so stale subscriptions do not consume instance connection capacity.
  await env.DB.batch(Object.entries(PROVIDERS).map(([name, definition]) => env.DB.prepare(
    `DELETE FROM realtime_subscriptions WHERE provider=? AND NOT EXISTS (
      SELECT 1 FROM ${definition.table} a WHERE a.id=realtime_subscriptions.account_id
        AND a.user_id=realtime_subscriptions.user_id)`
  ).bind(name)))
  await env.DB.batch([
    env.DB.prepare('DELETE FROM realtime_nonces WHERE expires_at < ?').bind(Math.floor(now / 1000)),
    env.DB.prepare('DELETE FROM realtime_measurements WHERE created_at < ?').bind(Math.floor(now / 1000) - 7 * 86400),
  ])
  const { results } = await env.DB.prepare(`SELECT subscription_id FROM realtime_jobs
    WHERE requested_seq > completed_seq AND lease_until <= ? AND next_attempt_at <= ? LIMIT 50`)
    .bind(now, now).all<{ subscription_id: string }>()
  for (const job of results) await env.MAIL_QUEUE.send({ kind: 'realtime-sync', subscriptionId: job.subscription_id })
}

export async function runRealtimeJob(env: Env, id: string): Promise<'done' | 'retry'> {
  const measured = realtimeMetrics(env); const started = Date.now()
  let outcome = 'error'
  try { const result = await executeRealtimeJob(measured.env, id); outcome = result; return result }
  finally { console.info(JSON.stringify({ event: 'realtime_job', subscriptionId: id, outcome,
    durationMs: Date.now()-started, ...measured.counts })) }
}
