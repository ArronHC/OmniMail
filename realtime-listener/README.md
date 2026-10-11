# OmniMail optional IMAP IDLE listener

Node.js ≥22, TypeScript, ImapFlow. One managed read-only INBOX connection per authorized account; no message bodies or attachments are stored here. Mail indexing and OAuth refresh remain in Cloudflare.

```bash
npm ci
npm test
npm run build
cp .env.example .env
npm run device:init -- ./secrets vps-primary
```

Register the generated public key in the owner UI, upload service keys with Worker Secrets, grant explicit per-account consent, then start the Docker service. Protect the generated private key, passphrase and HMAC files; do not paste them into issue/chat logs. Files must be mode 0600 and readable by container uid 1000.

See [complete deployment and rollback](../docs/realtime/DEPLOYMENT.md), [provider limitations](../docs/realtime/PROVIDERS.md), [cost assumptions](../docs/realtime/COST.md), and [tests / real latency measurement](../docs/realtime/VALIDATION.md).

Foreground Web/Android uses index updates; Android background instant push is not implemented. A 10-second delivery target must be verified with your actual providers and Cloudflare deployment.
