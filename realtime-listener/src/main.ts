import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { createPrivateKey } from 'node:crypto'
import { WorkerApi } from './api.js'
import { ListenerManager } from './listener.js'

function number(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`Invalid ${name}`)
  return value
}
function secretFile(name: string) {
  const path = process.env[name]
  if (!path) throw Error(`Missing ${name}`)
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) throw Error(`${name} must have mode 0600 or stricter`)
  return readFileSync(path, 'utf8').trim()
}
const api = new WorkerApi(process.env.OMNIMAIL_ORIGIN || '', process.env.DEVICE_KEY_ID || '', secretFile('SERVICE_KEY_FILE'), createPrivateKey({ key: secretFile('DEVICE_PRIVATE_KEY_FILE'), passphrase: secretFile('DEVICE_PASSPHRASE_FILE') }))
const options = {
  maxConnections: number('MAX_CONNECTIONS', 20, 1, 100),
  fallbackSeconds: number('FALLBACK_SECONDS', 300, 60, 3600),
  reconcileSeconds: number('RECONCILE_SECONDS', 60, 30, 300),
  debounceMs: number('EVENT_DEBOUNCE_MS', 250, 100, 3000),
}
const manager = new ListenerManager(api, options)
await manager.reconcile()
const reconciliation = setInterval(() => void manager.reconcile(), options.reconcileSeconds * 1000)
const server = createServer((request, response) => {
  if (request.url !== '/health') { response.writeHead(404).end(); return }
  response.writeHead(manager.healthy() ? 200 : 503, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ healthy: manager.healthy(), active: manager.entries.size, metrics: manager.metrics }))
})
server.listen(number('HEALTH_PORT', 9090, 1024, 65535), '0.0.0.0')
function shutdown() { clearInterval(reconciliation); manager.stop(); server.close(); setTimeout(() => process.exit(0), 2000).unref() }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
