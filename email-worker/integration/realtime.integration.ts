import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { Env, SessionUser } from '../src/app/types'
import type { AppContext } from '../src/app/context'
import { encryptMicrosoftCredential, microsoftCredentialContext } from '../src/features/microsoft/microsoft-credentials'
import { MicrosoftTokenError } from '../src/features/microsoft/microsoft-token'
import { encryptGmailCredential } from '../src/features/gmail/gmail-credentials'
import { authenticateService, signServiceRequest, signatureInput } from '../src/features/realtime/service-auth'
import { realtimeServiceApi } from '../src/features/realtime/service-api'
import { realtimeRoutes } from '../src/features/realtime/user-api'
import { receiveRealtimeEvent, runRealtimeJob, recoverRealtimeJobs } from '../src/features/realtime/jobs'
import { deviceCredential, credentialVersion } from '../src/features/realtime/credentials'
import { validSubscription } from '../src/features/realtime/types'

const refreshToken = vi.fn()
vi.mock('../src/features/microsoft/microsoft-token', async (original) => ({ ...await original<typeof import('../src/features/microsoft/microsoft-token')>(), refreshMicrosoftToken: (...args: unknown[]) => refreshToken(...args) }))
const open = vi.fn()
const mailbox = vi.fn()
vi.mock('../src/features/gmail/gmail-imap', () => ({ GmailImapClient: class {
  open = open
  async examineInbox() { return mailbox() }
  async searchAfter() { return { uids: [101], scannedThrough: 101 } }
  async searchLatestUids() { return [101] }
  async fetchMetadata() { return [{ imapUid: 101, gmailMessageId: 'remote-101', gmailThreadId: 'thread-101', messageIdHeader: '<101@test>', senderName: 'Sender', senderAddress: 'sender@test.com', recipients: [], cc: [], subject: 'Realtime arrival', preview: '', internalDate: 1000, sizeBytes: 100, flags: [], labels: ['\\Inbox'], isRead: false, isStarred: false, hasAttachments: false }] }
  async close() {}
} }))
const secret = 'realtime-test-service-key-at-least-32-bytes'
const queueSend = vi.fn(async () => undefined)
const environment = (): Env => ({ ...env, REALTIME_ENABLED: 'true', GMAIL_CREDENTIALS_KEY: 'realtime-gmail-credential-key-at-least-32-bytes', REALTIME_SERVICE_KEYS: JSON.stringify({ current: { deviceId: 'realtime-device', secret } }), MAIL_QUEUE: { send: queueSend } as unknown as Env['MAIL_QUEUE'] })
let privateKey: CryptoKey
let publicKey: JsonWebKey
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']) as CryptoKeyPair
  privateKey = keys.privateKey; publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey
})
beforeEach(async () => {
  open.mockReset(); queueSend.mockClear(); mailbox.mockReturnValue({ uidValidity: 1, uidNext: 102 })
  await env.DB.prepare("DELETE FROM users WHERE id = 'realtime-user'").run()
  await env.DB.prepare("DELETE FROM realtime_devices WHERE id = 'realtime-device'").run()
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES('realtime_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
  await env.DB.prepare("INSERT INTO users(id,email,display_name,password_hash,role) VALUES('realtime-user','realtime@example.com','Realtime','test','user')").run()
  await env.DB.prepare('INSERT INTO realtime_devices(id,name,public_key,enabled,created_at) VALUES(?, ?, ?, 1, 1)')
    .bind('realtime-device', 'Test device', JSON.stringify(publicKey)).run()
  const cipher = await encryptGmailCredential(environment(), 'test-app-password', 'realtime-user:realtime-gmail:app-password')
  await env.DB.prepare(`INSERT INTO gmail_imap_accounts(id,user_id,name,email,app_password_cipher,status,uid_validity,last_seen_uid,next_sync_at,created_at,updated_at)
    VALUES('realtime-gmail','realtime-user','Test','test@gmail.com',?,'active',1,100,9999999999,1,1)`).bind(cipher).run()
  await env.DB.prepare(`INSERT INTO realtime_subscriptions(id,user_id,provider,account_id,device_id,enabled,updated_at)
    VALUES('realtime-sub','realtime-user','gmail','realtime-gmail','realtime-device',1,1)`).run()
})
async function signed(path: string, payload?: unknown, nonce = crypto.randomUUID().replaceAll('-', '')) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const method = payload === undefined ? 'GET' : 'POST'; const time = String(Date.now())
  return new Request(`https://mail.example.com${path}`, { method, body: body || undefined, headers: {
    'X-Omni-Key': 'current', 'X-Omni-Time': time, 'X-Omni-Nonce': nonce,
    'X-Omni-Signature': await signServiceRequest(secret, signatureInput(method, path, time, nonce, body)),
  } })
}
const context = { waitUntil: vi.fn() } as unknown as ExecutionContext

describe('realtime service with real D1 and Gmail indexing', () => {
  it('publishes indexed metadata through the real user WebSocket object', async () => {
    const app = new Hono<AppContext>()
    app.use('*', async (c,next) => {c.set('user',{id:'realtime-user',role:'user'} as SessionUser); await next()})
    app.route('/api/realtime',realtimeRoutes)
    const response = await app.request('https://mail.example.com/api/realtime/updates', { headers: { Upgrade: 'websocket' } },environment())
    expect(response.status).toBe(101)
    const socket = response.webSocket!
    socket.accept()
    const received = new Promise<unknown>((resolve) => socket.addEventListener('message', (event) => {
      const body = JSON.parse(String(event.data))
      if (body.type === 'indexed') resolve(body)
    }))
    await receiveRealtimeEvent(environment(), 'realtime-sub', Date.now())
    await runRealtimeJob(environment(), 'realtime-sub')
    expect(await received).toMatchObject({ type: 'indexed', provider: 'gmail', accountId: 'realtime-gmail' })
    socket.close()
  })
  it('verifies signatures, rejects tampering and consumes each nonce once', async () => {
    const request = await signed('/api/internal/realtime/manifest')
    expect(await authenticateService(request, environment(), '')).toBe('realtime-device')
    expect(await authenticateService(request, environment(), '')).toBeNull()
    expect(await authenticateService(await signed('/api/internal/realtime/events', {}), environment(), '{"tampered":true}')).toBeNull()
  })
  it('rejects browser origins, stale timestamps and disabled devices', async () => {
    const browser = await signed('/api/internal/realtime/manifest'); browser.headers.set('Origin', 'https://mail.example.com')
    expect(await authenticateService(browser, environment(), '')).toBeNull()
    const stale = await signed('/api/internal/realtime/manifest')
    expect(await authenticateService(stale, environment(), '', Date.now() + 120_000)).toBeNull()
    await env.DB.prepare("UPDATE realtime_devices SET enabled=0 WHERE id='realtime-device'").run()
    expect(await authenticateService(await signed('/api/internal/realtime/manifest'), environment(), '')).toBeNull()
  })
  it('reuses incremental sync despite ordinary scheduling cooldown and persists one message', async () => {
    await receiveRealtimeEvent(environment(), 'realtime-sub', Date.now())
    expect(await runRealtimeJob(environment(), 'realtime-sub')).toBe('done')
    expect(await env.DB.prepare("SELECT subject FROM gmail_imap_messages WHERE account_id='realtime-gmail'").first()).toEqual({ subject: 'Realtime arrival' })
    await receiveRealtimeEvent(environment(), 'realtime-sub', Date.now(), Date.now() + 4000)
    await env.DB.prepare("UPDATE realtime_jobs SET next_attempt_at=0 WHERE subscription_id='realtime-sub'").run()
    await runRealtimeJob(environment(), 'realtime-sub')
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM gmail_imap_messages WHERE account_id='realtime-gmail'").first()).toEqual({ count: 1 })
  })
  it('coalesces event bursts and excludes concurrent indexing', async () => {
    const now = Date.now()
    expect(await receiveRealtimeEvent(environment(), 'realtime-sub', now, now)).toBe(true)
    expect(await receiveRealtimeEvent(environment(), 'realtime-sub', now, now + 1)).toBe(false)
    await Promise.all([runRealtimeJob(environment(), 'realtime-sub'), runRealtimeJob(environment(), 'realtime-sub')])
    expect(open).toHaveBeenCalledTimes(1)
    expect(queueSend).toHaveBeenCalledTimes(1)
  })
  it('shares the existing account lease with manual and scheduled synchronization', async () => {
    await receiveRealtimeEvent(environment(), 'realtime-sub', Date.now())
    await env.DB.prepare("UPDATE gmail_imap_accounts SET sync_lease_id='manual',sync_lease_until=? WHERE id='realtime-gmail'").bind(Math.floor(Date.now()/1000)+60).run()
    expect(await runRealtimeJob(environment(), 'realtime-sub')).toBe('retry')
    expect(open).not.toHaveBeenCalled()
    await env.DB.prepare("UPDATE gmail_imap_accounts SET sync_lease_until=0 WHERE id='realtime-gmail'").run()
    await env.DB.prepare("UPDATE realtime_jobs SET next_attempt_at=0 WHERE subscription_id='realtime-sub'").run()
    expect(await runRealtimeJob(environment(), 'realtime-sub')).toBe('done')
  })
  it('recovers durable pending work after a queue-send failure or process restart', async () => {
    queueSend.mockRejectedValueOnce(new Error('queue unavailable'))
    await expect(receiveRealtimeEvent(environment(), 'realtime-sub', Date.now())).rejects.toThrow()
    await recoverRealtimeJobs(environment())
    expect(queueSend).toHaveBeenLastCalledWith({ kind: 'realtime-sync', subscriptionId: 'realtime-sub' })
    expect(await runRealtimeJob(environment(), 'realtime-sub')).toBe('done')
  })
  it('cannot expose credentials or sync after account deletion, user disabling or consent revocation', async () => {
    await env.DB.prepare("UPDATE users SET status='disabled' WHERE id='realtime-user'").run()
    expect(await validSubscription(environment(), 'realtime-sub')).toBeNull()
    await env.DB.prepare("UPDATE users SET status='active' WHERE id='realtime-user'").run()
    await env.DB.prepare("UPDATE realtime_subscriptions SET enabled=0 WHERE id='realtime-sub'").run()
    expect(await validSubscription(environment(), 'realtime-sub')).toBeNull()
    await env.DB.prepare("UPDATE realtime_subscriptions SET enabled=1 WHERE id='realtime-sub'").run()
    await env.DB.prepare("DELETE FROM gmail_imap_accounts WHERE id='realtime-gmail'").run()
    expect(await runRealtimeJob(environment(), 'realtime-sub')).toBe('done')
    expect(open).not.toHaveBeenCalled()
  })
  it('fails closed for a forged account or generation without invoking sync', async () => {
    const request = await signed('/api/internal/realtime/events', { subscriptionId: 'other-user-account', generation: 1, type: 'exists', detectedAt: Date.now() })
    const response = await realtimeServiceApi(request, environment(), context)
    expect(response.status).toBe(403)
    expect(queueSend).not.toHaveBeenCalled()
  })
  it('encrypts one authorized credential with the registered device key', async () => {
    const subscription = (await validSubscription(environment(), 'realtime-sub'))!
    const encrypted = await deviceCredential(environment(), subscription)
    const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
    const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, decode(encrypted.key))
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(encrypted.iv), additionalData: new TextEncoder().encode(encrypted.aad) }, key, decode(encrypted.ciphertext))
    const payload = JSON.parse(new TextDecoder().decode(plaintext))
    expect(payload.auth).toEqual({ pass: 'test-app-password' })
    expect(payload.version).toBe(await credentialVersion(environment(), subscription))
    expect(payload).not.toHaveProperty('refreshToken')
    expect(JSON.stringify(encrypted)).not.toContain('test-app-password')
  })
  it('requires owner permission for devices/global settings and account ownership for consent', async () => {
    const app = new Hono<AppContext>()
    app.use('*', async (c, next) => { c.set('user', { id: 'realtime-user', role: 'user' } as SessionUser); await next() })
    app.route('/api/realtime', realtimeRoutes)
    expect((await app.request('/api/realtime/admin/config', { method: 'PUT', body: '{"enabled":true}' }, environment())).status).toBe(403)
    expect((await app.request('/api/realtime/subscriptions', { method: 'PUT', body: JSON.stringify({ provider: 'gmail', accountId: 'foreign-account', deviceId: 'realtime-device', enabled: true }) }, environment())).status).toBe(404)
  })
})

describe('realtime compensation policy', () => {
  it('reduces redundant scheduled work only for healthy IDLE and restores offline fallback', async () => {
    const { extendRealtimeCompensation, restoreOfflineCompensation } = await import('../src/features/realtime/compensation')
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare("UPDATE realtime_devices SET last_seen_at=? WHERE id='realtime-device'").bind(now).run()
    await env.DB.prepare("UPDATE realtime_subscriptions SET listener_state='idle' WHERE id='realtime-sub'").run()
    await env.DB.prepare("UPDATE gmail_imap_accounts SET next_sync_at=? WHERE id='realtime-gmail'").bind(now + 300).run()
    await extendRealtimeCompensation(environment(), 'gmail', 'realtime-gmail', now)
    expect(await env.DB.prepare("SELECT next_sync_at FROM gmail_imap_accounts WHERE id='realtime-gmail'").first()).toEqual({ next_sync_at: now + 1800 })
    await env.DB.prepare("UPDATE realtime_devices SET last_seen_at=? WHERE id='realtime-device'").bind(now - 180).run()
    await restoreOfflineCompensation(environment(), now)
    expect(await env.DB.prepare("SELECT next_sync_at FROM gmail_imap_accounts WHERE id='realtime-gmail'").first()).toEqual({ next_sync_at: now })
  })
  it('the feature can be turned off while ordinary scheduled Gmail sync remains available', async () => {
    const { enqueueDueGmailSyncs } = await import('../src/features/gmail/gmail-sync')
    await env.DB.prepare("UPDATE settings SET value='0' WHERE key='realtime_enabled'").run()
    expect(await validSubscription(environment(), 'realtime-sub')).toBeNull()
    await env.DB.prepare("UPDATE gmail_imap_accounts SET next_sync_at=0 WHERE id='realtime-gmail'").run()
    expect(await enqueueDueGmailSyncs(environment())).toBe(1)
    expect(queueSend).toHaveBeenLastCalledWith({ kind: 'gmail-sync', accountId: 'realtime-gmail', reason: 'scheduled' })
  })
})


describe('Microsoft listener credentials', () => {
  async function microsoftSubscription() {
    const e = environment()
    const encrypt = (value: string, purpose: 'refresh-token' | 'access-token') => encryptMicrosoftCredential(e, value, microsoftCredentialContext('realtime-user', 'realtime-ms', purpose))
    await env.DB.prepare(`INSERT INTO microsoft_imap_accounts(id,user_id,name,provided_email,normalized_email,auth_mode,client_id,refresh_token_cipher,access_token_cipher,access_token_expires_at,status,created_at,updated_at)
      VALUES('realtime-ms','realtime-user','Microsoft','test@outlook.com','test@outlook.com','oauth2','test-client',?,?,0,'active',1,1)`)
      .bind(await encrypt('worker-only-refresh-token', 'refresh-token'), await encrypt('expired-access-token', 'access-token')).run()
    await env.DB.prepare(`INSERT INTO realtime_subscriptions(id,user_id,provider,account_id,device_id,enabled,updated_at)
      VALUES('realtime-ms-sub','realtime-user','microsoft','realtime-ms','realtime-device',1,1)`).run()
    return (await validSubscription(e, 'realtime-ms-sub'))!
  }
  it('refreshes expired OAuth tokens on Worker and sends only a short-lived access token', async () => {
    const subscription = await microsoftSubscription()
    refreshToken.mockResolvedValue({ accessToken: 'fresh-access-token', refreshToken: 'rotated-worker-only-refresh-token', expiresIn: 3600 })
    const before = await credentialVersion(environment(), subscription)
    const envelope = await deviceCredential(environment(), subscription)
    expect(refreshToken).toHaveBeenCalled()
    expect(await credentialVersion(environment(), subscription)).toBe(before)
    const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
    const raw = await crypto.subtle.decrypt('RSA-OAEP', privateKey, bytes(envelope.key))
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: new TextEncoder().encode(envelope.aad) }, key, bytes(envelope.ciphertext))
    const payload = JSON.parse(new TextDecoder().decode(plaintext))
    expect(payload.auth).toEqual({ accessToken: 'fresh-access-token' })
    expect(payload.tokenExpiresAt).toBeGreaterThan(Date.now())
    expect(new TextDecoder().decode(plaintext)).not.toContain('refresh-token')
  })
  it('a revoked Microsoft refresh token cannot produce a listener credential', async () => {
    const subscription = await microsoftSubscription()
    refreshToken.mockRejectedValue(new MicrosoftTokenError('invalid_grant', false))
    await expect(deviceCredential(environment(), subscription)).rejects.toThrow()
  })
})

describe('realtime limits and key rotation', () => {
  it('accepts a limited overlap key and rejects an expired rotation key', async () => {
    const e = environment()
    e.REALTIME_SERVICE_KEYS = JSON.stringify({ current: { deviceId: 'realtime-device', secret, notAfter: Date.now()+60_000 } })
    expect(await authenticateService(await signed('/api/internal/realtime/manifest'), e, '')).toBe('realtime-device')
    e.REALTIME_SERVICE_KEYS = JSON.stringify({ current: { deviceId: 'realtime-device', secret, notAfter: 'invalid-time' } })
    expect(await authenticateService(await signed('/api/internal/realtime/manifest'), e, '')).toBeNull()
    e.REALTIME_SERVICE_KEYS = JSON.stringify({ current: { deviceId: 'realtime-device', secret, notAfter: Date.now()-1 } })
    expect(await authenticateService(await signed('/api/internal/realtime/manifest'), e, '')).toBeNull()
  })
  it('enforces an atomic daily device request cap', async () => {
    await env.DB.prepare("UPDATE realtime_devices SET request_day=?,daily_requests=100 WHERE id='realtime-device'").bind(Math.floor(Date.now()/86_400_000)).run()
    expect(await authenticateService(await signed('/api/internal/realtime/manifest'), { ...environment(), REALTIME_DEVICE_REQUESTS_PER_DAY: '100' }, '')).toBeNull()
  })
  it('bounds event syncs per account while retaining durable pending work', async () => {
    await receiveRealtimeEvent(environment(), 'realtime-sub', Date.now())
    await env.DB.prepare("UPDATE realtime_jobs SET sync_day=?,daily_syncs=10 WHERE subscription_id='realtime-sub'").bind(Math.floor(Date.now()/86_400_000)).run()
    expect(await runRealtimeJob({ ...environment(), REALTIME_ACCOUNT_SYNCS_PER_DAY: '10' }, 'realtime-sub')).toBe('done')
    expect(open).not.toHaveBeenCalled()
    expect(await env.DB.prepare("SELECT last_error FROM realtime_subscriptions WHERE id='realtime-sub'").first()).toEqual({ last_error: 'daily_sync_budget' })
    expect(await env.DB.prepare("SELECT requested_seq,completed_seq FROM realtime_jobs WHERE subscription_id='realtime-sub'").first()).toEqual({ requested_seq: 1, completed_seq: 0 })
  })
  it('restores scheduled work immediately when the environment switch is disabled', async () => {
    const { restoreOfflineCompensation } = await import('../src/features/realtime/compensation')
    const now = Math.floor(Date.now()/1000)
    await restoreOfflineCompensation({ ...environment(), REALTIME_ENABLED: 'false' }, now)
    expect(await env.DB.prepare("SELECT next_sync_at FROM gmail_imap_accounts WHERE id='realtime-gmail'").first()).toEqual({ next_sync_at: now })
  })
})


describe('realtime final recovery verification', () => {
  it('resets the Gmail UID cursor when UIDVALIDITY changes to a smaller UID space', async () => {
    mailbox.mockReturnValue({uidValidity: 2, uidNext: 102})
    await env.DB.prepare("UPDATE gmail_imap_accounts SET last_seen_uid=10000 WHERE id='realtime-gmail'").run()
    await receiveRealtimeEvent(environment(), 'realtime-sub', Date.now())
    await runRealtimeJob(environment(), 'realtime-sub')
    expect(await env.DB.prepare("SELECT uid_validity,last_seen_uid FROM gmail_imap_accounts WHERE id='realtime-gmail'").first()).toEqual({uid_validity:2,last_seen_uid:101})
  })
  it('recovers an expired shared account lease and catches up the dirty event', async () => {
    await env.DB.prepare("UPDATE gmail_imap_accounts SET sync_lease_id='expired',sync_lease_until=1,status='syncing' WHERE id='realtime-gmail'").run()
    await receiveRealtimeEvent(environment(), 'realtime-sub', Date.now())
    expect(await runRealtimeJob(environment(), 'realtime-sub')).toBe('done')
    expect(open).toHaveBeenCalledTimes(1)
  })
  it('accepts an event durably without running a cancellable HTTP-background sync', async () => {
    const waitUntil = vi.fn()
    const request = await signed('/api/internal/realtime/events',{subscriptionId:'realtime-sub',generation:1,type:'exists',detectedAt:Date.now()})
    expect((await realtimeServiceApi(request, environment(), {waitUntil} as unknown as ExecutionContext)).status).toBe(202)
    expect(queueSend).toHaveBeenCalled()
    expect(waitUntil).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})


describe('trusted device key replacement', () => {
  it('revokes prior account consent when an owner replaces the device public key', async () => {
    const app = new Hono<AppContext>()
    app.use('*', async (c,next) => {c.set('user',{id:'realtime-user',role:'super_admin'} as SessionUser); await next()})
    app.route('/api/realtime',realtimeRoutes)
    const keys = await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']) as CryptoKeyPair
    const publicKey = await crypto.subtle.exportKey('jwk',keys.publicKey)
    const response = await app.request('/api/realtime/admin/devices/realtime-device',{method:'PUT',body:JSON.stringify({name:'Replacement',publicKey,enabled:true})},environment())
    expect(response.status).toBe(200)
    expect(await validSubscription(environment(),'realtime-sub')).toBeNull()
    expect(await env.DB.prepare("SELECT enabled,generation FROM realtime_subscriptions WHERE id='realtime-sub'").first()).toEqual({enabled:0,generation:2})
  })
})


describe('late sync fencing', () => {
  it('does not write a stale IMAP response after another task takes over the account lease', async () => {
    open.mockImplementationOnce(async () => {
      await env.DB.prepare("UPDATE gmail_imap_accounts SET sync_lease_id='new-owner',sync_lease_until=? WHERE id='realtime-gmail'").bind(Math.floor(Date.now()/1000)+360).run()
    })
    await receiveRealtimeEvent(environment(),'realtime-sub',Date.now())
    expect(await runRealtimeJob(environment(),'realtime-sub')).toBe('retry')
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM gmail_imap_messages WHERE account_id='realtime-gmail'").first()).toEqual({count:0})
    expect(await env.DB.prepare("SELECT sync_lease_id FROM gmail_imap_accounts WHERE id='realtime-gmail'").first()).toEqual({sync_lease_id:'new-owner'})
  })
})


describe('deleted provider account cleanup', () => {
  it('reclaims the stale authorization and capacity after account deletion', async () => {
    await env.DB.prepare("DELETE FROM gmail_imap_accounts WHERE id='realtime-gmail'").run()
    await recoverRealtimeJobs(environment())
    expect(await env.DB.prepare("SELECT id FROM realtime_subscriptions WHERE id='realtime-sub'").first()).toBeNull()
  })
})
