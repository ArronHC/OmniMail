import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/app/types'
import { encryptICloudCredential } from '../src/features/icloud/icloud-credentials'
import { encryptLinuxDoMailCredential } from '../src/features/linux-do-mail/linux-do-mail-credentials'
import { credentialVersion, deviceCredential } from '../src/features/realtime/credentials'
import { receiveRealtimeEvent, runRealtimeJob } from '../src/features/realtime/jobs'
import { validSubscription } from '../src/features/realtime/types'

const { Client, login } = vi.hoisted(() => {
  const login = vi.fn()
  class Client {
    constructor(email: string, password: string) { login(email, password) }
    async open() {}
    async examineInbox() { return { uidValidity: 1, uidNext: 102 } }
    async searchLatestUids() { return [101] }
    async searchAfter() { return { uids: [101], scannedThrough: 101 } }
    async fetchMetadata() {
      return [{ imapUid: 101, messageIdHeader: '<101@test>', senderName: 'Sender',
        senderAddress: 'sender@example.com', recipients: [], subject: 'Realtime arrival',
        internalDate: 1000, sizeBytes: 100, flags: [], isRead: false, hasAttachments: false }]
    }
    async close() {}
  }
  return { Client, login }
})
vi.mock('../src/features/icloud/icloud-imap', () => ({ ICloudImapClient: Client }))
vi.mock('../src/features/linux-do-mail/linux-do-mail-imap', () => ({ LinuxDoMailImapClient: Client }))

const environment = (): Env => ({ ...env, REALTIME_ENABLED: 'true',
  MAIL_CREDENTIALS_KEY: 'realtime-provider-credential-key-at-least-32-bytes',
  MAIL_QUEUE: { send: vi.fn(async () => undefined) } as unknown as Env['MAIL_QUEUE'] })
let privateKey: CryptoKey
let publicKey: JsonWebKey
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']) as CryptoKeyPair
  privateKey = keys.privateKey
  publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey
})
beforeEach(async () => {
  login.mockClear()
  await env.DB.prepare("DELETE FROM users WHERE id = 'provider-user'").run()
  await env.DB.prepare("DELETE FROM realtime_devices WHERE id = 'provider-device'").run()
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES('realtime_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
  await env.DB.prepare("INSERT INTO users(id,email,display_name,password_hash,role) VALUES('provider-user','provider@example.com','Provider','test','user')").run()
  await env.DB.prepare("INSERT INTO realtime_devices(id,name,public_key,enabled,created_at) VALUES('provider-device','Test',?,1,1)")
    .bind(JSON.stringify(publicKey)).run()
})

const providers = [
  { provider: 'icloud', table: 'icloud_accounts', messages: 'icloud_imap_messages', host: 'imap.mail.me.com', email: 'test@icloud.com', column: 'app_password_cipher' },
  { provider: 'linuxdo', table: 'linux_do_mail_accounts', messages: 'linux_do_mail_messages', host: 'mail.linux.do', email: 'test@linux.do', column: 'password_cipher' },
] as const

describe.each(providers)('$provider realtime support', ({ provider, table, messages, host, email, column }) => {
  async function setup() {
    const e = environment()
    const cipher = provider === 'icloud'
      ? await encryptICloudCredential(e, 'provider-password', `provider-user:${provider}:app-password`)
      : await encryptLinuxDoMailCredential(e, 'provider-password', `provider-user:${provider}:password`)
    const sql = provider === 'icloud'
      ? "INSERT INTO icloud_accounts(id,user_id,name,icloud_email,app_password_cipher,status,created_at,updated_at) VALUES(?,'provider-user','iCloud',?,?,'active','now','now')"
      : "INSERT INTO linux_do_mail_accounts(id,user_id,username,password_cipher,status,created_at,updated_at) VALUES(?,'provider-user',?,?,'active','now','now')"
    await env.DB.prepare(sql).bind(provider, email, cipher).run()
    await env.DB.prepare("INSERT INTO realtime_subscriptions(id,user_id,provider,account_id,device_id,enabled,updated_at) VALUES(?,'provider-user',?,?,'provider-device',1,1)")
      .bind(provider, provider, provider).run()
    return (await validSubscription(e, provider))!
  }

  it('encrypts the correct login and detects credential changes', async () => {
    const subscription = await setup()
    const encrypted = await deviceCredential(environment(), subscription)
    const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
    const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, decode(encrypted.key))
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(encrypted.iv),
      additionalData: new TextEncoder().encode(encrypted.aad) }, key, decode(encrypted.ciphertext))
    const payload = JSON.parse(new TextDecoder().decode(plaintext))
    expect(payload).toMatchObject({ provider, host, email, port: 993, secure: true, auth: { pass: 'provider-password' } })
    expect(JSON.stringify(encrypted)).not.toContain('provider-password')
    const version = await credentialVersion(environment(), subscription)
    await env.DB.prepare(`UPDATE ${table} SET ${column} = 'changed' WHERE id = ?`).bind(provider).run()
    expect(await credentialVersion(environment(), subscription)).not.toBe(version)
  })

  it('uses the existing incremental sync and records completion', async () => {
    await setup()
    await receiveRealtimeEvent(environment(), provider, Date.now())
    expect(await runRealtimeJob(environment(), provider)).toBe('done')
    expect(login).toHaveBeenCalledWith(email, 'provider-password')
    expect(await env.DB.prepare(`SELECT subject FROM ${messages} WHERE account_id = ?`).bind(provider).first())
      .toEqual({ subject: 'Realtime arrival' })
    expect(await env.DB.prepare('SELECT requested_seq,completed_seq FROM realtime_jobs WHERE subscription_id = ?').bind(provider).first())
      .toEqual({ requested_seq: 1, completed_seq: 1 })
  })

  it('respects existing sync leases and rejects foreign credentials', async () => {
    const subscription = await setup()
    await expect(deviceCredential(environment(), { ...subscription, user_id: 'another-user' })).rejects.toThrow()
    await env.DB.prepare(`UPDATE ${table} SET sync_lease_id = 'manual', sync_lease_until = ? WHERE id = ?`)
      .bind(Math.floor(Date.now() / 1000) + 60, provider).run()
    await receiveRealtimeEvent(environment(), provider, Date.now())
    expect(await runRealtimeJob(environment(), provider)).toBe('retry')
    expect(login).not.toHaveBeenCalled()
  })
})
