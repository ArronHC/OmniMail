import type { Env } from '../../app/types'
import { gmailAccountForSync } from '../gmail/gmail-store'
import { microsoftAccountForSync } from '../microsoft/microsoft-store'
import { microsoftAccessToken } from '../microsoft/microsoft-token-manager'
import { qqMailAccountForSync } from '../qq-mail/qq-mail-store'
import { naverMailAccountForSync } from '../naver-mail/naver-mail-store'
import { yandexMailAccountForSync } from '../yandex-mail/yandex-mail-store'
import { ICloudAccountStore } from '../icloud/icloud-store'
import { LinuxDoMailAccountStore } from '../linux-do-mail/linux-do-mail-store'
import { PROVIDERS, type Subscription } from './types'

const encoder = new TextEncoder()
function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
}
export async function publicDeviceKey(value: unknown): Promise<CryptoKey> {
  if (!value || typeof value !== 'object') throw new Error('Invalid public key')
  const jwk = value as JsonWebKey
  if (jwk.kty !== 'RSA' || jwk.d || jwk.p || jwk.q || !jwk.n
    || jwk.n.length < 342 || jwk.n.length > 1024 || jwk.e !== 'AQAB') throw new Error('Invalid public key')
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
}
export async function credentialVersion(env: Env, subscription: Subscription) {
  const table = PROVIDERS[subscription.provider].table
  // Refresh-token rotation is routine, not a user credential change. The store
  // increments subscription generation when the user replaces OAuth credentials.
  const columns = subscription.provider === 'microsoft' ? "client_id || ':' || authority"
    : subscription.provider === 'qq' ? 'authorization_code_cipher'
    : subscription.provider === 'linuxdo' ? 'password_cipher' : 'app_password_cipher'
  const row = await env.DB.prepare(`SELECT ${columns} AS cipher FROM ${table} WHERE id = ? AND user_id = ?`)
    .bind(subscription.account_id, subscription.user_id).first<{ cipher: string }>()
  if (!row) throw new Error('Account unavailable')
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${subscription.generation}:${row.cipher}`))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function deviceCredential(env: Env, subscription: Subscription) {
  let email: string; let auth: { pass?: string; accessToken?: string }; let tokenExpiresAt: number | undefined
  if (subscription.provider === 'microsoft') {
    const account = await microsoftAccountForSync(env, subscription.account_id)
    if (!account || account.userId !== subscription.user_id) throw new Error('Account unavailable')
    const accessToken = await microsoftAccessToken(env, account)
    const latest = await microsoftAccountForSync(env, subscription.account_id)
    email = account.normalizedEmail
    auth = { accessToken }
    tokenExpiresAt = latest?.accessTokenExpiresAt ? latest.accessTokenExpiresAt * 1000 : Date.now() + 300_000
  } else if (subscription.provider === 'qq') {
    const account = await qqMailAccountForSync(env, subscription.account_id)
    if (!account || account.userId !== subscription.user_id) throw new Error('Account unavailable')
    email = account.email; auth = { pass: account.authorizationCode }
  } else if (subscription.provider === 'icloud') {
    const account = await new ICloudAccountStore(env, subscription.user_id).get(subscription.account_id)
    if (account.userId !== subscription.user_id || !account.icloudEmail || !account.appPassword) throw new Error('Account unavailable')
    email = account.icloudEmail; auth = { pass: account.appPassword }
  } else if (subscription.provider === 'linuxdo') {
    const account = await new LinuxDoMailAccountStore(env, subscription.user_id).get()
    if (account.id !== subscription.account_id || account.userId !== subscription.user_id || !account.password) throw new Error('Account unavailable')
    email = account.username; auth = { pass: account.password }
  } else {
    const load = subscription.provider === 'gmail' ? gmailAccountForSync
      : subscription.provider === 'naver' ? naverMailAccountForSync : yandexMailAccountForSync
    const account = await load(env, subscription.account_id)
    if (!account || account.userId !== subscription.user_id) throw new Error('Account unavailable')
    email = account.email; auth = { pass: account.appPassword }
  }
  const device = await env.DB.prepare('SELECT public_key FROM realtime_devices WHERE id = ? AND enabled = 1')
    .bind(subscription.device_id).first<{ public_key: string }>()
  if (!device) throw new Error('Device unavailable')
  const expiresAt = Math.min(Date.now() + 600_000, tokenExpiresAt || Infinity)
  const payload = {
    subscriptionId: subscription.id, generation: subscription.generation,
    version: await credentialVersion(env, subscription), provider: subscription.provider,
    host: PROVIDERS[subscription.provider].host, port: 993, secure: true,
    email, auth, expiresAt, tokenExpiresAt,
  }
  // Hybrid envelope avoids RSA plaintext size limits. AAD binds the account and expiry.
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']) as CryptoKey
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = `${subscription.id}:${subscription.generation}:${expiresAt}`
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(JSON.stringify(payload)))
  const rawKey = await crypto.subtle.exportKey('raw', key) as ArrayBuffer
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, await publicDeviceKey(JSON.parse(device.public_key)), rawKey)
  return { algorithm: 'RSA-OAEP-256+A256GCM', aad, expiresAt, key: b64(new Uint8Array(wrapped)), iv: b64(iv), ciphertext: b64(new Uint8Array(encrypted)) }
}
