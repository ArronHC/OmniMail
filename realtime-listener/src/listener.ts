import { ImapFlow } from 'imapflow'
import type { Credential, ManifestAccount } from './api.js'
import { ServiceError, WorkerApi } from './api.js'

export function reconnectDelay(attempt: number, authentication = false, random = Math.random) {
  const base = authentication ? 900_000 : Math.min(300_000, 5000 * 2 ** Math.min(attempt, 6))
  return Math.round(base * (0.8 + random() * 0.4))
}
export type ListenerOptions = { maxConnections: number; fallbackSeconds: number; reconcileSeconds: number; debounceMs: number }
export type ImapFactory = (credential: Credential) => ImapFlow
const defaultFactory: ImapFactory = (c) => new ImapFlow({
  host: c.host, port: c.port, secure: true, auth: { user: c.email, ...c.auth },
  logger: false, emitLogs: false, disableCompression: true,
  connectionTimeout: 30_000, greetingTimeout: 15_000, socketTimeout: 30 * 60_000,
  maxIdleTime: 25 * 60_000, tls: { rejectUnauthorized: true },
})
type Entry = {
  account: ManifestAccount; client?: ImapFlow; stopped: boolean; connecting: boolean
  timer?: NodeJS.Timeout; debounce?: NodeJS.Timeout; heartbeat?: NodeJS.Timeout
  tokenTimer?: NodeJS.Timeout; attempt: number; eventAt?: number; eventType?: 'exists' | 'reconnected' | 'fallback'
  sending: boolean; idle: boolean
}
export class ListenerManager {
  readonly entries = new Map<string, Entry>()
  readonly metrics = { connectionAttempts: 0, authenticationFailures: 0, connections: 0, disconnects: 0, detected: 0, sent: 0, coalesced: 0, failures: 0 }
  private stopped = false
  private lastManifestAt = 0
  constructor(private api: WorkerApi, private options: ListenerOptions, private factory: ImapFactory = defaultFactory,
    private log: (record: Record<string, unknown>) => void = (record) => console.log(JSON.stringify(record))) {}
  healthy() { return !this.stopped && Date.now() - this.lastManifestAt < this.options.reconcileSeconds * 3000 }
  async reconcile() {
    try {
      const manifest = await this.api.manifest()
      if (this.stopped) return
      if (Math.abs(manifest.serverTime - Date.now()) > 60_000) throw Error('Clock skew')
      this.lastManifestAt = Date.now()
      const desired = new Map(manifest.accounts.slice(0, this.options.maxConnections).map((a) => [a.id, a]))
      for (const [id, entry] of this.entries) {
        const target = desired.get(id)
        if (!target || target.version !== entry.account.version || target.generation !== entry.account.generation) this.remove(id)
      }
      for (const account of desired.values()) {
        if (this.entries.has(account.id)) continue
        const entry: Entry = { account, stopped: false, connecting: false, attempt: 0, sending: false, idle: false }
        this.entries.set(account.id, entry)
        void this.connect(entry)
      }
      if (manifest.accounts.length > this.options.maxConnections) this.log({ event: 'capacity_limit', configured: this.options.maxConnections, authorized: manifest.accounts.length })
    } catch (error) {
      this.metrics.failures++
      this.log({ event: 'manifest_failed', status: error instanceof ServiceError ? error.status : 0 })
      // Fail closed after two missed manifests, rather than listening indefinitely after revocation.
      if (Date.now() - this.lastManifestAt > this.options.reconcileSeconds * 2000) {
        for (const id of this.entries.keys()) this.remove(id)
      }
    }
  }
  private async connect(entry: Entry) {
    if (entry.stopped || entry.connecting || this.stopped) return
    entry.connecting = true; this.metrics.connectionAttempts++
    try {
      const credential = await this.api.credentials(entry.account)
      if (entry.stopped) return
      const client = this.factory(credential)
      entry.client = client
      client.on('error', () => { /* close event owns reconnect; never log raw protocol errors */ })
      client.on('close', () => {
        if (entry.client !== client) return
        entry.client = undefined; this.metrics.disconnects++
        this.retry(entry, false)
      })
      client.on('exists', () => this.notify(entry, 'exists'))
      await client.connect()
      if (entry.stopped) { client.close(); return }
      await client.mailboxOpen('INBOX', { readOnly: true })
      entry.idle = client.capabilities.has('IDLE')
      if (entry.idle) void client.idle().catch(() => client.close())
      entry.attempt = 0; this.metrics.connections++
      this.log({ event: 'connected', account: entry.account.id, provider: entry.account.provider, idle: entry.idle })
      await this.api.status(entry.account, entry.idle ? 'idle' : 'fallback').catch(() => undefined)
      this.notify(entry, 'reconnected') // Catch up arrivals while disconnected; Worker owns UID cursor.
      entry.heartbeat = setInterval(() => {
        if (entry.stopped) return
        if (entry.idle) void client.noop().then(() => client.idle()).catch(() => client.close())
        else this.notify(entry, 'fallback')
      }, (entry.idle ? 300 : this.options.fallbackSeconds) * 1000)
      // A Microsoft access token is never refreshed on the VPS. Reconnect using Worker-issued credentials.
      if (credential.tokenExpiresAt) entry.tokenTimer = setTimeout(() => client.close(), Math.max(5000, credential.tokenExpiresAt - Date.now() - 90_000))
    } catch (error) {
      this.metrics.failures++
      const authentication = error instanceof ServiceError && [401, 403].includes(error.status)
        || typeof error === 'object' && error !== null && 'authenticationFailed' in error && Boolean(error.authenticationFailed)
      if (authentication) this.metrics.authenticationFailures++
      const oldClient = entry.client; entry.client = undefined; oldClient?.close()
      await this.api.status(entry.account, authentication ? 'authentication_failed' : 'backoff').catch(() => undefined)
      this.retry(entry, authentication)
    } finally { entry.connecting = false }
  }
  private retry(entry: Entry, authentication: boolean) {
    if (entry.stopped || this.stopped || entry.timer) return
    clearInterval(entry.heartbeat); clearTimeout(entry.tokenTimer)
    const delay = reconnectDelay(entry.attempt++, authentication)
    this.log({ event: 'reconnect_scheduled', account: entry.account.id, delayMs: delay, authentication })
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.connect(entry) }, delay)
  }
  private notify(entry: Entry, type: 'exists' | 'reconnected' | 'fallback') {
    if (entry.stopped) return
    this.metrics.detected++
    if (entry.eventAt) this.metrics.coalesced++
    entry.eventAt ??= Date.now(); entry.eventType = type
    if (entry.debounce || entry.sending) return
    entry.debounce = setTimeout(() => { entry.debounce = undefined; void this.send(entry) }, this.options.debounceMs)
  }
  private async send(entry: Entry) {
    if (entry.stopped || entry.sending || !entry.eventAt) return
    const at = entry.eventAt; const type = entry.eventType || 'exists'
    entry.eventAt = undefined; entry.sending = true
    try { await this.api.event(entry.account, type, at); this.metrics.sent++ }
    catch (error) {
      this.metrics.failures++
      if (error instanceof ServiceError && [401, 403].includes(error.status)) { this.remove(entry.account.id); return }
      entry.eventAt = Math.max(at, Date.now() - 3500_000)
      entry.debounce = setTimeout(() => { entry.debounce = undefined; void this.send(entry) }, 30_000)
    } finally {
      entry.sending = false
      if (entry.eventAt && !entry.debounce && !entry.stopped) this.notify(entry, entry.eventType || 'exists')
    }
  }
  remove(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.stopped = true
    clearTimeout(entry.timer); clearTimeout(entry.debounce); clearInterval(entry.heartbeat); clearTimeout(entry.tokenTimer)
    entry.client?.close(); entry.client = undefined
    this.entries.delete(id)
  }
  stop() { this.stopped = true; for (const id of this.entries.keys()) this.remove(id) }
}
