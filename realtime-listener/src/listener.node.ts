import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ListenerManager, reconnectDelay } from './listener.js'
import type { WorkerApi, ManifestAccount, Credential } from './api.js'
import type { ImapFlow } from 'imapflow'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const account: ManifestAccount = { id: 'test', provider: 'gmail', generation: 1, version: 'v1' }
class MockImap extends EventEmitter {
  capabilities = new Map([['IDLE', true]])
  closed = false
  failAuthentication = false
  async connect() { if(this.failAuthentication) throw Object.assign(Error("redacted"), {authenticationFailed:true}) }
  async mailboxOpen(path: string, options: { readOnly: boolean }) { assert.equal(path, 'INBOX'); assert.equal(options.readOnly, true) }
  async noop() {}
  async idle() {}
  close() { this.closed = true; this.emit('close') }
}
function fixture(failAuthentication = false) {
  const clients: MockImap[] = []; const events: unknown[] = []; let desired = [account]
  const api = {
    async manifest() { return { accounts: desired, serverTime: Date.now() } },
    async credentials(a: ManifestAccount) { return { ...a, subscriptionId: a.id, host: 'imap.gmail.com', port: 993, secure: true, email: 'test@gmail.com', auth: { pass: 'fake' }, expiresAt: Date.now() + 600000 } as Credential },
    async event(a: ManifestAccount, type: string) { events.push({ id: a.id, type }) },
    async status() {},
  } as unknown as WorkerApi
  const manager = new ListenerManager(api, { maxConnections: 2, fallbackSeconds: 300, reconcileSeconds: 60, debounceMs: 5 }, () => {
    const client = new MockImap(); client.failAuthentication = failAuthentication; clients.push(client); return client as unknown as ImapFlow
  }, () => undefined)
  return { manager, clients, events, setDesired: (value: ManifestAccount[]) => { desired = value } }
}
test('IDLE events are coalesced and no body or metadata fetch is needed', async () => {
  const f = fixture()
  try {
    await f.manager.reconcile(); await sleep(20)
    f.events.length = 0
    f.clients[0].emit('exists'); f.clients[0].emit('exists'); f.clients[0].emit('exists')
    await sleep(20)
    assert.deepEqual(f.events, [{ id: 'test', type: 'exists' }])
    assert.equal(f.manager.metrics.coalesced, 2)
  } finally { f.manager.stop() }
})
test('revocation closes the account; changed credentials replace its connection', async () => {
  const f = fixture()
  try {
    await f.manager.reconcile(); await sleep(20)
    f.setDesired([{ ...account, version: 'v2' }]); await f.manager.reconcile(); await sleep(20)
    assert.equal(f.clients[0].closed, true); assert.equal(f.clients.length, 2)
    f.setDesired([]); await f.manager.reconcile()
    assert.equal(f.clients[1].closed, true); assert.equal(f.manager.entries.size, 0)
  } finally { f.manager.stop() }
})
test('network loss schedules bounded reconnect and does not affect a second account', async () => {
  const f = fixture()
  try {
    f.setDesired([account, { ...account, id: 'second' }]); await f.manager.reconcile(); await sleep(20)
    f.clients[0].emit('close')
    assert.ok(f.manager.entries.get('test')?.timer)
    assert.equal(f.clients[1].closed, false)
    await sleep(6200)
    assert.equal(f.clients.length, 3)
    assert.equal(f.clients[2].closed, false)
    assert.equal(reconnectDelay(0, false, () => 0.5), 5000)
    assert.equal(reconnectDelay(100, false, () => 0.5), 300000)
    assert.equal(reconnectDelay(0, true, () => 0.5), 900000)
  } finally { f.manager.stop() }
})
test('unsupported IDLE is reported as fallback without assuming provider capabilities', async () => {
  const f = fixture()
  try {
    await f.manager.reconcile()
    f.clients[0].capabilities.clear(); await sleep(20)
    assert.equal(f.manager.entries.get('test')?.idle, false)
  } finally { f.manager.stop() }
})

test('bad IMAP credentials cool down without reconnecting in a tight loop', async () => {
  const f = fixture(true)
  try {
    await f.manager.reconcile(); await sleep(100)
    assert.equal(f.clients.length,1)
    assert.equal(f.manager.metrics.authenticationFailures,1)
    assert.equal(f.manager.metrics.connections,0)
    const timer = f.manager.entries.get('test')?.timer as unknown as {_idleTimeout:number}
    assert.ok(timer._idleTimeout>=720000 && timer._idleTimeout<=1080000)
  } finally {f.manager.stop()}
})
