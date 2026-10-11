import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../../app/types'

// One object per user. No periodic D1 polling and sockets hibernate when idle.
export class RealtimeUpdates extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/publish' && request.method === 'POST') {
      const body = await request.text()
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(body) } catch { socket.close(1011, 'Reconnect') }
      }
      return new Response(null, { status: 204 })
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 })
    if (this.ctx.getWebSockets().length >= 8) return new Response('Connection limit reached', { status: 429 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment({ expiresAt: Date.now() + 300_000 })
    if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 300_000)
    pair[1].send(JSON.stringify({ type: 'connected' }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') socket.send('pong')
    else socket.close(1008, 'Only heartbeat messages are accepted')
  }
  async alarm() {
    let next = Infinity
    for (const socket of this.ctx.getWebSockets()) {
      const { expiresAt } = socket.deserializeAttachment() as { expiresAt: number }
      if (expiresAt <= Date.now()) socket.close(1000, 'Reauthenticate')
      else next = Math.min(next, expiresAt)
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next)
  }
}
