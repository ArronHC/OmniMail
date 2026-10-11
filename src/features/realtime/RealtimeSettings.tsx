import { useCallback, useEffect, useState } from 'react'
import { request, ApiError } from '../../shared/api/api-client'
import { t } from '../../shared/i18n'
import './realtime-settings.css'

type Device = { id: string; name: string; enabled: number; last_seen_at: number | null }
type Account = { id: string; name: string; email: string; provider: string }
type Subscription = { id: string; provider: string; account_id: string; device_id: string; enabled: number; listener_state: string; last_event_at: number | null; last_sync_at: number | null; last_duration_ms: number | null; last_error: string; device_last_seen_at?: number }
type Measurement = { detected_at: number; received_at: number; indexed_at: number; provider: string }
const percentile = (values: number[], p: number) => values.length ? `${Math.round([...values].sort((a,b) => a-b)[Math.ceil(p*values.length)-1])} ms` : '—'
const sources = { gmail: 'gmail', microsoft: 'microsoft', qq: 'qq-mail', naver: 'naver-mail', yandex: 'yandex-mail' }
const json = (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body) })
const time = (value: number | null) => value ? new Date(value).toLocaleString() : '—'
export function RealtimeSettings({ owner, onEnabledChange }: { owner: boolean; onEnabledChange?: (enabled: boolean) => void }) {
  const [available, setAvailable] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [account, setAccount] = useState('')
  const [consent, setConsent] = useState(false)
  const [registration, setRegistration] = useState('')
  const [registerId, setRegisterId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try {
      const config = await request<{ enabled: boolean }>('/api/realtime/config')
      setAvailable(true); setEnabled(config.enabled)
      const [d, s] = await Promise.all([
        request<{ devices: Device[] }>('/api/realtime/devices'),
        request<{ subscriptions: Subscription[]; measurements?: Measurement[] }>(owner ? '/api/realtime/admin/status' : '/api/realtime/subscriptions'),
      ])
      setDevices(d.devices); setSubscriptions(s.subscriptions); setMeasurements(s.measurements || [])
      const found: Account[] = []
      for (const [provider, path] of Object.entries(sources)) {
        try { const response = await request<{ accounts: Array<{ id: string; name: string; email: string }> }>(`/api/${path}/accounts`)
          found.push(...response.accounts.map((a) => ({ ...a, provider }))) } catch { /* unavailable integrations stay absent */ }
      }
      setAccounts(found)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setAvailable(false); return }
      setError(e instanceof Error ? e.message : t('无法读取实时同步状态'))
    }
  }, [owner])
  useEffect(() => { void load() }, [load])
  async function action(task: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await task(); await load() } catch (e) { setError(e instanceof Error ? e.message : t('操作失败')) }
    finally { setBusy(false) }
  }
  if (!available) return error ? <p role="alert">{error}</p> : null
  return <section className="admin-card account-card realtime-settings">
    <header><h2>{t('实时邮件同步')}</h2><p>{enabled ? t('事件监听已启用，定时同步作为补偿') : t('当前仅使用定时同步')}</p></header>
    {error && <p role="alert">{error}</p>}
    {owner && <label><input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void action(async () => { const value = e.target.checked; await request('/api/realtime/admin/config', json({ enabled: value })); onEnabledChange?.(value) })} />{t('全局启用实时同步')}</label>}
    <p>{t('授权后，所选可信设备可以在内存中使用该邮箱登录凭据。仅授权你控制的 VPS；撤销后监听器通常在一分钟内断开。')}</p>
    <form onSubmit={(e) => {
      e.preventDefault(); const selected = accounts.find((a) => `${a.provider}:${a.id}` === account)
      if (selected && consent) void action(() => request('/api/realtime/subscriptions', json({ provider: selected.provider, accountId: selected.id, deviceId, enabled: true })))
    }}>
      <label>{t('邮箱账号')}<select value={account} onChange={(e) => setAccount(e.target.value)} required><option value="">{t('请选择')}</option>{accounts.map((a) => <option key={`${a.provider}:${a.id}`} value={`${a.provider}:${a.id}`}>{a.provider} · {a.name} ({a.email})</option>)}</select></label>
      <label>{t('可信监听设备')}<select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} required><option value="">{t('请选择')}</option>{devices.filter((d) => d.enabled).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{t('我授权该设备使用此邮箱的登录凭据')}</label>
      <button className="button" disabled={busy || !consent || !enabled}>{t('启用此邮箱')}</button>
    </form>
    <button className="button button--secondary" disabled={busy} onClick={() => void load()}>{t('刷新连接状态')}</button>
    <div style={{ overflowX: 'auto' }}><table><thead><tr><th>{t('邮箱')}</th><th>{t('监听状态')}</th><th>{t('最近事件')}</th><th>{t('最近同步')}</th><th>{t('耗时')}</th><th>{t('操作')}</th></tr></thead><tbody>
      {subscriptions.map((s) => <tr key={s.id}><td>{accounts.find((a) => a.id === s.account_id)?.email || s.account_id} · {s.provider}</td><td>{!s.enabled ? t('已关闭') : s.device_last_seen_at && Date.now() - s.device_last_seen_at * 1000 > 120000 ? t('VPS 离线，定时补偿') : s.listener_state}{s.last_error && ` · ${s.last_error}`}</td><td>{time(s.last_event_at)}</td><td>{time(s.last_sync_at)}</td><td>{s.last_duration_ms ?? '—'} ms</td><td>
        <button disabled={busy || !s.enabled} onClick={() => void action(() => request(`/api/realtime/subscriptions/${s.id}/action`, { method: 'POST', body: '{"type":"reconnect"}' }))}>{t('重连')}</button>
        <button disabled={busy || !s.enabled} onClick={() => void action(() => request(`/api/realtime/subscriptions/${s.id}/action`, { method: 'POST', body: '{"type":"sync"}' }))}>{t('立即同步')}</button>
        <button disabled={busy || !s.enabled} onClick={() => void action(() => request(`/api/realtime/subscriptions/${s.id}/action`, { method: 'POST', body: '{"type":"disable"}' }))}>{t('撤销')}</button>
      </td></tr>)}
    </tbody></table></div>
    {owner && <p>{t('事件发现至索引完成（最近 1000 个批次，不含客户端显示）')} · P50 {percentile(measurements.map((m) => m.indexed_at-m.detected_at), .5)} · P95 {percentile(measurements.map((m) => m.indexed_at-m.detected_at), .95)} · P99 {percentile(measurements.map((m) => m.indexed_at-m.detected_at), .99)}</p>}
    {owner && <details><summary>{t('注册可信 VPS')}</summary><p>{t('从监听器生成文件中导入设备公钥。服务签名密钥通过 Worker Secrets 配置，不在此输入。')}</p>
      <form onSubmit={(e) => { e.preventDefault(); void action(async () => { const body = JSON.parse(registration); await request(`/api/realtime/admin/devices/${encodeURIComponent(registerId)}`, json(body)) }) }}>
        <label>{t('设备标识')}<input value={registerId} onChange={(e) => setRegisterId(e.target.value)} pattern="[A-Za-z0-9_-]{1,64}" required /></label>
        <label>{t('设备公钥 JSON')}<textarea value={registration} onChange={(e) => setRegistration(e.target.value)} required /></label>
        <button className="button" disabled={busy}>{t('注册或更新设备')}</button>
      </form>
      <ul>{devices.map((d) => <li key={d.id}>{d.name} · {d.enabled ? t('可信') : t('已停用')} · {d.last_seen_at ? time(d.last_seen_at * 1000) : t('尚未连接')} <button disabled={busy} onClick={() => void action(() => request(`/api/realtime/admin/devices/${d.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !d.enabled }) }))}>{d.enabled ? t('停用设备') : t('信任设备')}</button></li>)}</ul>
    </details>}
    <p>{t('IMAP IDLE 支持由服务商实际能力决定；退化状态仍使用定时同步。Android 前台可实时更新，后台秒级推送尚未启用。')}</p>
  </section>
}
