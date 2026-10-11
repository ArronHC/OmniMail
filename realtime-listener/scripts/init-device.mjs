import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const directory = resolve(process.argv[2] || 'secrets')
const deviceId = process.argv[3] || 'vps-primary'
if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) throw Error('Invalid device id')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const passphrase = randomBytes(32).toString('hex')
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 })
const secret = randomBytes(32).toString('hex')
for (const [name, content] of Object.entries({
  'device-private.pem': keys.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }),
  'device-passphrase': passphrase,
  'service-key': secret,
  'worker-service-keys.json': JSON.stringify({ [deviceId]: { deviceId, secret } }),
  'device-public.json': JSON.stringify({ name: deviceId, enabled: true, publicKey: keys.publicKey.export({ format: 'jwk' }) }, null, 2),
})) writeFileSync(resolve(directory, name), content, { mode: 0o600, flag: 'wx' })
console.log(`Device files created under ${directory}. Register device ${deviceId} and upload the Worker key file securely; never paste key values into chat.`)
