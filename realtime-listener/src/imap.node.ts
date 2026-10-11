import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type TLSSocket } from 'node:tls'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ImapFlow } from 'imapflow'
import { ListenerManager } from './listener.js'
import type { WorkerApi, Credential } from './api.js'

// Real TLS transport and ImapFlow protocol. CA verification stays enabled.
test('mock IMAP IDLE arrival traverses ImapFlow and generates the listener event callback', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'omnimail-imap-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
  const certificate = readFileSync(join(directory, 'cert.pem'))
  const sockets = new Set<TLSSocket>()
  let arrived!: () => void
  const event = new Promise<void>((resolve) => { arrived = resolve })
  const server = createServer({ key: readFileSync(join(directory, 'key.pem')), cert: certificate }, (socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.write('* OK Mock IMAP ready\r\n')
    let buffer = ''; let idleTag = ''
    socket.on('data', (bytes) => {
      buffer += bytes.toString()
      while (buffer.includes('\r\n')) {
        const i = buffer.indexOf('\r\n'); const line = buffer.slice(0, i); buffer = buffer.slice(i + 2)
        if (line === 'DONE') { socket.write(`${idleTag} OK IDLE completed\r\n`); continue }
        const [tag, command] = line.split(' ')
        if (command === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 IDLE\r\n${tag} OK capabilities\r\n`)
        else if (command === 'LOGIN') socket.write(`${tag} OK authenticated\r\n`)
        else if (command === 'LIST') socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK list\r\n`)
        else if (command === 'EXAMINE') socket.write(`* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 1] next\r\n${tag} OK [READ-ONLY] selected\r\n`)
        else if (command === 'IDLE') { idleTag = tag; socket.write('+ idling\r\n'); setTimeout(() => socket.write('* 1 EXISTS\r\n'), 100) }
        else if (command === 'LOGOUT') { socket.write(`* BYE closed\r\n${tag} OK logout\r\n`); socket.end() }
        else socket.write(`${tag} OK completed\r\n`)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const account = { id: 'mock', provider: 'gmail', generation: 1, version: 'v1' }
  const api = {
    async manifest() { return { accounts: [account], serverTime: Date.now() } },
    async credentials() { return { subscriptionId: 'mock', generation: 1, version: 'v1', provider: 'gmail', host: 'imap.gmail.com', port: 993, secure: true, email: 'test@example.com', auth: { pass: 'mock-password' }, expiresAt: Date.now() + 600000 } as Credential },
    async status() {},
    async event(_account: unknown, type: string) { if (type === 'exists') arrived() },
  } as unknown as WorkerApi
  const manager = new ListenerManager(api, { maxConnections: 1, fallbackSeconds: 300, reconcileSeconds: 60, debounceMs: 10 }, (credential) => new ImapFlow({
    host: '127.0.0.1', port: address.port, secure: true, auth: { user: credential.email, pass: credential.auth.pass }, logger: false,
    tls: { ca: certificate, servername: 'localhost', rejectUnauthorized: true }, connectionTimeout: 3000,
  }), () => undefined)
  try { await manager.reconcile(); await event; assert.equal(manager.metrics.sent >= 1, true) }
  finally { manager.stop(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }) }
})
