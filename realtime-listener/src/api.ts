import { createHmac, randomBytes, constants, privateDecrypt, createDecipheriv, type KeyObject } from 'node:crypto'

export type ManifestAccount = { id: string; provider: string; generation: number; version: string }
export type Credential = {
  subscriptionId: string; generation: number; version: string; provider: string
  host: string; port: number; secure: boolean; email: string
  auth: { pass?: string; accessToken?: string }; expiresAt: number; tokenExpiresAt?: number
}
export class ServiceError extends Error {
  constructor(readonly status: number) { super(`Service request failed (${status})`) }
}
export class WorkerApi {
  constructor(readonly origin: string, private keyId: string, private secret: string, private privateKey: KeyObject, private fetcher: typeof fetch = fetch) {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('A plain HTTPS Worker origin is required')
    if (Buffer.byteLength(secret) < 32 || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw Error('Invalid service identity')
  }
  async request<T>(path: string, payload?: unknown): Promise<T> {
    const method = payload === undefined ? 'GET' : 'POST'
    const body = payload === undefined ? '' : JSON.stringify(payload)
    const timestamp = String(Date.now()); const nonce = randomBytes(24).toString('base64url')
    const signature = createHmac('sha256', this.secret).update(['omnimail-realtime-v1', method, path, timestamp, nonce, body].join('\n')).digest('hex')
    const response = await this.fetcher(`${this.origin.replace(/\/$/, '')}${path}`, {
      method, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', 'X-Omni-Key': this.keyId, 'X-Omni-Time': timestamp, 'X-Omni-Nonce': nonce, 'X-Omni-Signature': signature },
    })
    if (!response.ok) throw new ServiceError(response.status)
    // Never log response bodies: credential envelopes are sensitive too.
    return await response.json() as T
  }
  manifest() { return this.request<{ accounts: ManifestAccount[]; serverTime: number }>('/api/internal/realtime/manifest') }
  async credentials(account: ManifestAccount): Promise<Credential> {
    const envelope = await this.request<{ aad: string; expiresAt: number; key: string; iv: string; ciphertext: string }>('/api/internal/realtime/credentials', { subscriptionId: account.id, generation: account.generation })
    const key = privateDecrypt({ key: this.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.key, 'base64'))
    const bytes = Buffer.from(envelope.ciphertext, 'base64')
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
    cipher.setAAD(Buffer.from(envelope.aad)); cipher.setAuthTag(bytes.subarray(-16))
    const plaintext = Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()])
    try {
      const result = JSON.parse(plaintext.toString()) as Credential
      const hosts: Record<string, string> = { gmail: 'imap.gmail.com', microsoft: 'outlook.office365.com', qq: 'imap.qq.com', naver: 'imap.naver.com', yandex: 'imap.yandex.com', icloud: 'imap.mail.me.com', linuxdo: 'mail.linux.do' }
      if (result.subscriptionId !== account.id || result.generation !== account.generation
        || result.provider !== account.provider || result.version !== account.version
        || envelope.aad !== `${account.id}:${account.generation}:${result.expiresAt}`
        || envelope.expiresAt !== result.expiresAt || result.expiresAt <= Date.now()
        || result.expiresAt > Date.now() + 610_000 || result.host !== hosts[result.provider]
        || result.port !== 993 || result.secure !== true || !result.email
        || (!result.auth.pass && !result.auth.accessToken)) throw Error('Invalid credential envelope')
      return result
    } finally { key.fill(0); plaintext.fill(0) }
  }
  event(account: ManifestAccount, type: 'exists' | 'reconnected' | 'fallback', detectedAt: number) {
    return this.request('/api/internal/realtime/events', { subscriptionId: account.id, generation: account.generation, type, detectedAt })
  }
  status(account: ManifestAccount, state: string) {
    return this.request('/api/internal/realtime/status', { subscriptionId: account.id, generation: account.generation, state })
  }
}
