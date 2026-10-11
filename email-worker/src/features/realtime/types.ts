import type { Env } from '../../app/types'

export const PROVIDERS = {
  gmail: { table: 'gmail_imap_accounts', host: 'imap.gmail.com' },
  microsoft: { table: 'microsoft_imap_accounts', host: 'outlook.office365.com' },
  qq: { table: 'qq_mail_accounts', host: 'imap.qq.com' },
  naver: { table: 'naver_mail_accounts', host: 'imap.naver.com' },
  yandex: { table: 'yandex_mail_accounts', host: 'imap.yandex.com' },
} as const
export type Provider = keyof typeof PROVIDERS
export type Subscription = {
  id: string; user_id: string; provider: Provider; account_id: string
  device_id: string; enabled: number; generation: number
}
export function provider(value: unknown): value is Provider {
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value)
}
export function realtimeEnabled(env: Env): boolean {
  return env.REALTIME_ENABLED === 'true'
}
export function bounded(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}
export async function validSubscription(env: Env, id: string, deviceId?: string) {
  const global = await env.DB.prepare("SELECT value FROM settings WHERE key = 'realtime_enabled'").first<{ value: string }>()
  if (global?.value !== '1') return null
  const row = await env.DB.prepare(
    `SELECT s.* FROM realtime_subscriptions s
     JOIN realtime_devices d ON d.id = s.device_id AND d.enabled = 1
     JOIN users u ON u.id = s.user_id AND u.status = 'active' AND u.deleted_at IS NULL
     WHERE s.id = ? AND s.enabled = 1
       AND (u.temporary_expires_at IS NULL OR u.temporary_expires_at > unixepoch())`,
  ).bind(id).first<Subscription>()
  if (!row || deviceId && row.device_id !== deviceId) return null
  if (row.provider === 'gmail' && env.GMAIL_IMAP_ENABLED === 'false'
    || row.provider === 'microsoft' && env.MICROSOFT_MAIL_ENABLED === 'false'
    || row.provider === 'qq' && env.QQ_MAIL_IMAP_ENABLED === 'false') return null
  const account = await env.DB.prepare(
    `SELECT id, status FROM ${PROVIDERS[row.provider].table} WHERE id = ? AND user_id = ?`,
  ).bind(row.account_id, row.user_id).first<{ id: string; status: string }>()
  if (!account || ['credential_error', 'permission_error', 'pending_validation', 'disabled'].includes(account.status)) return null
  return row
}
