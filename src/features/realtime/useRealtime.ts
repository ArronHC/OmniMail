import { useEffect, useRef } from 'react'

export type IndexEvent = { type: string; provider?: string; accountId?: string; indexedAt?: number; measurementId?: string; subscriptionId?: string }
const EVENT = 'omnimail-index-update'
export function useRealtimeConnection(enabled: boolean, userId: string) {
  useEffect(() => {
    if (!enabled) return
    const origin = (import.meta.env.VITE_API_ORIGIN || window.location.origin).replace(/\/$/, '')
    let active = true; let socket: WebSocket | undefined; let retry: number | undefined
    let release: (() => void) | undefined; let queued: AbortController | undefined; let attempt = 0
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`omnimail-realtime-${userId}`) : undefined
    const dispatch = (event: IndexEvent) => window.dispatchEvent(new CustomEvent(EVENT, { detail: event }))
    if (channel) channel.onmessage = (message: MessageEvent<IndexEvent>) => dispatch(message.data)
    const connect = () => {
      if (!active || document.visibilityState !== 'visible') return
      const url = new URL(`${origin}/api/realtime/updates`)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url)
      socket.onopen = () => { attempt = 0; const event = { type: 'reconnected' }; dispatch(event); channel?.postMessage(event) }
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as IndexEvent
          if (event.type !== 'indexed') return
          dispatch(event); channel?.postMessage(event)
        } catch { /* malformed messages do not refresh */ }
      }
      socket.onclose = () => {
        if (active && document.visibilityState === 'visible') retry = window.setTimeout(connect, Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6)) * (0.8 + Math.random() * 0.4))
      }
      socket.onerror = () => socket?.close()
    }
    const stop = () => {
      if (retry) window.clearTimeout(retry)
      if (socket) { socket.onclose = null; socket.close(); socket = undefined }
      queued?.abort(); queued = undefined; release?.(); release = undefined
    }
    const acquire = () => {
      if (!active || document.visibilityState !== 'visible') return
      if (!navigator.locks?.request || !channel) { connect(); return }
      queued = new AbortController()
      void navigator.locks.request(`omnimail-realtime-${userId}`, { signal: queued.signal }, async () => {
        queued = undefined
        if (!active || document.visibilityState !== 'visible') return
        await new Promise<void>((resolve) => { release = resolve; connect() })
      }).catch(() => undefined)
    }
    const visibility = () => { stop(); acquire() }
    document.addEventListener('visibilitychange', visibility); acquire()
    return () => { active = false; stop(); channel?.close(); document.removeEventListener('visibilitychange', visibility) }
  }, [enabled, userId])
}
export function useRealtimeRefresh(provider: string, accountId: string, refresh: () => Promise<unknown>) {
  const callback = useRef(refresh)
  useEffect(() => { callback.current = refresh }, [refresh])
  useEffect(() => {
    let timer: number | undefined; let running = false; let dirty = false; let active = true
    const run = async () => {
      if (!active || running) { dirty = true; return }
      running = true
      try { await callback.current() } catch { /* Workspaces display their refresh errors. */ } finally {
        running = false
        if (active && dirty) { dirty = false; timer = window.setTimeout(() => void run(), 250) }
      }
    }
    const receive = (message: Event) => {
      const event = (message as CustomEvent<IndexEvent>).detail
      if (document.visibilityState !== 'visible' || event.type === 'indexed' && (event.provider !== provider || accountId && event.accountId !== accountId)) return
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => void run(), 100)
    }
    window.addEventListener(EVENT, receive)
    return () => { active = false; if (timer) window.clearTimeout(timer); window.removeEventListener(EVENT, receive) }
  }, [provider, accountId])
}
