import { Radio, LoaderCircle, RefreshCw, PlugZap, Unplug, Trash2, ShieldCheck, ShieldOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { request, ApiError } from '../../shared/api/api-client'
import { t } from '../../shared/i18n'
import './realtime-settings.css'

type Device = { id: string; name: string; enabled: number; last_seen_at: number | null }
type Account = { id: string; name: string; email: string; provider: string }
type Subscription = { id: string; provider: string; account_id: string; device_id: string; enabled: number; listener_state: string; last_event_at: number | null; last_sync_at: number | null; last_duration_ms: number | null; last_error: string; device_last_seen_at?: number }
type Measurement = { detected_at: number; received_at: number; indexed_at: number; provider: string }

const percentile = (values: number[], p: number) => values.length ? `${Math.round([...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1])} ms` : '—'
const sources = { gmail: 'gmail', microsoft: 'microsoft', qq: 'qq-mail', naver: 'naver-mail', yandex: 'yandex-mail', icloud: 'icloud', linuxdo: 'linuxdo-mail' }
const json = (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body) })
const time = (value: number | null) => value ? new Date(value).toLocaleString() : '—'

// Deduplicate devices by id; when duplicated, the last entry wins.
function dedupeDevices(devices: Device[]): Device[] {
  const map = new Map<string, Device>()
  for (const d of devices) map.set(d.id, d)
  return [...map.values()]
}

function subscriptionStatus(s: Subscription): { key: string; label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (!s.enabled) return { key: 'off', label: t('已关闭'), tone: 'muted' }
  if (s.last_error) return { key: 'error', label: t('错误'), tone: 'bad' }
  if (s.device_last_seen_at && Date.now() - s.device_last_seen_at * 1000 > 120000)
    return { key: 'offline', label: t('VPS 离线，定时补偿'), tone: 'warn' }
  return { key: 'live', label: s.listener_state || t('监听中'), tone: 'ok' }
}

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
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const config = await request<{ enabled: boolean }>('/api/realtime/config')
      setAvailable(true); setEnabled(config.enabled)
      const [d, s] = await Promise.all([
        request<{ devices: Device[] }>('/api/realtime/devices'),
        request<{ subscriptions: Subscription[]; measurements?: Measurement[] }>(owner ? '/api/realtime/admin/status' : '/api/realtime/subscriptions'),
      ])
      setDevices(dedupeDevices(d.devices)); setSubscriptions(s.subscriptions); setMeasurements(s.measurements || [])
      const found: Account[] = []
      for (const [provider, path] of Object.entries(sources)) {
        try {
          if (provider === 'linuxdo') {
            // LinuxDO exposes a single account under the hyphenated API prefix.
            const response = await request<{ account: { id: string; username: string } | null }>('/api/linux-do-mail/account')
            if (response.account) {
              const { id, username } = response.account
              found.push({ id, name: username, email: username, provider })
            }
          } else if (provider === 'icloud') {
            const response = await request<{ accounts: Array<{ id: string; name: string; icloudEmail: string; hasAppPassword: boolean }> }>(`/api/${path}/accounts`)
            found.push(...response.accounts.filter((a) => a.icloudEmail && a.hasAppPassword)
              .map((a) => ({ id: a.id, name: a.name, email: a.icloudEmail, provider })))
          } else {
            const response = await request<{ accounts: Array<{ id: string; name: string; email: string }> }>(`/api/${path}/accounts`)
            found.push(...response.accounts.map((a) => ({ ...a, provider })))
          }
        } catch { /* unavailable integrations stay absent */ }
      }
      setAccounts(found)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setAvailable(false); return }
      setError(e instanceof Error ? e.message : t('无法读取实时同步状态'))
    }
  }, [owner])

  useEffect(() => { void load() }, [load])

  async function action(label: string, task: () => Promise<unknown>, success?: string) {
    setBusy(label); setError(''); setNotice('')
    try { await task(); if (success) setNotice(t(success)); await load() }
    catch (e) { setError(e instanceof Error ? e.message : t('操作失败')) }
    finally { setBusy('') }
  }

  const trustedDevices = useMemo(() => devices.filter((d) => d.enabled), [devices])
  const selectedAccount = accounts.find((a) => `${a.provider}:${a.id}` === account)
  const step = !account ? 1 : !deviceId ? 2 : !consent ? 3 : 4

  if (!available) return error ? <p className="account-feedback" role="alert">{error}</p> : null

  return <section className="admin-card account-card realtime-card">
    <header><Radio size={17} /><div>
      <h2>{t('实时邮件同步')}</h2>
      <p>{enabled ? t('事件监听已启用，定时同步作为补偿') : t('当前仅使用定时同步')}</p>
    </div></header>

    {error && <p className="account-feedback" role="alert">{error}</p>}
    {notice && <p className="account-feedback account-feedback--ok" role="status">{notice}</p>}

    {owner && <label className="realtime-toggle">
      <input type="checkbox" checked={enabled} disabled={!!busy}
        onChange={(e) => void action('global', async () => {
          const value = e.target.checked
          await request('/api/realtime/admin/config', json({ enabled: value }))
          onEnabledChange?.(value)
        }, '全局实时同步设置已保存。')} />
      <span><strong>{t('全局启用实时同步')}</strong><small>{t('关闭后所有监听器断开，仅保留定时同步')}</small></span>
    </label>}

    <div className="realtime-connection {!enabled ? 'is-off' : ''}">
      <span className="realtime-connection-dot" />
      {enabled ? t('实时同步运行中') : t('实时同步未启用')}
    </div>

    <div className="realtime-section">
      <h3 className="realtime-section-title">{t('授权邮箱')}</h3>
      <p className="realtime-note">{t('授权后，所选可信设备可以在内存中使用该邮箱登录凭据。仅授权你控制的 VPS；撤销后监听器通常在一分钟内断开。')}</p>
      <form onSubmit={(e) => {
        e.preventDefault()
        if (selectedAccount && consent && deviceId) void action('enable', () => request('/api/realtime/subscriptions', json({
          provider: selectedAccount.provider, accountId: selectedAccount.id, deviceId, enabled: true,
        })), '邮箱实时同步已启用。')
      }}>
        <fieldset>
          <legend><span className="realtime-step">1</span>{t('选择邮箱账号')}</legend>
          <label className="realtime-field">
            <select value={account} onChange={(e) => setAccount(e.target.value)} required>
              <option value="">{t('请选择')}</option>
              {accounts.map((a) => <option key={`${a.provider}:${a.id}`} value={`${a.provider}:${a.id}`}>{a.provider} · {a.name} ({a.email})</option>)}
            </select>
          </label>
        </fieldset>
        <fieldset disabled={!account}>
          <legend><span className="realtime-step">2</span>{t('选择可信监听设备')}</legend>
          {trustedDevices.length === 0
            ? <p className="realtime-note">{t('暂无可信设备，请先在下方注册可信 VPS。')}</p>
            : <label className="realtime-field">
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} required>
                <option value="">{t('请选择')}</option>
                {trustedDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>}
        </fieldset>
        <fieldset disabled={!account || !deviceId}>
          <legend><span className="realtime-step">3</span>{t('确认授权')}</legend>
          <label className="realtime-check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            {t('我授权该设备使用此邮箱的登录凭据')}
          </label>
        </fieldset>
        <div className="realtime-actions">
          <button className="button" type="submit" disabled={!!busy || step < 4 || !enabled}>
            {busy === 'enable' && <LoaderCircle className="spin" size={15} />}{t('启用此邮箱')}
          </button>
          {!enabled && <p className="realtime-note">{t('需先由管理员全局启用实时同步。')}</p>}
        </div>
      </form>
    </div>

    <div className="realtime-section">
      <div className="realtime-section-head">
        <h3 className="realtime-section-title">{t('已授权邮箱')}</h3>
        <button className="button button--secondary" type="button" disabled={!!busy} onClick={() => void action('refresh', load)}>
          {busy === 'refresh' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{t('刷新连接状态')}
        </button>
      </div>
      {subscriptions.length === 0
        ? <p className="realtime-note">{t('尚未授权任何邮箱。')}</p>
        : <div className="realtime-sub-list">{subscriptions.map((s) => {
          const st = subscriptionStatus(s)
          const email = accounts.find((a) => a.id === s.account_id)?.email || s.account_id
          return <div key={s.id} className="realtime-sub">
            <div className="realtime-sub-main">
              <strong>{email}</strong><span className="realtime-note">{s.provider}</span>
              <span className={`realtime-pill realtime-pill--${st.tone}`}>{st.label}</span>
            </div>
            {s.last_error && <p className="realtime-error">{s.last_error}</p>}
            <div className="realtime-sub-meta">
              <span>{t('最近事件')}：{time(s.last_event_at)}</span>
              <span>{t('最近同步')}：{time(s.last_sync_at)}</span>
              <span>{t('耗时')}：{s.last_duration_ms ?? '—'} ms</span>
            </div>
            <div className="realtime-sub-actions">
              <button className="button button--secondary" type="button" disabled={!!busy || !s.enabled}
                onClick={() => void action(`reconnect-${s.id}`, () => request(`/api/realtime/subscriptions/${s.id}/action`, { method: 'POST', body: '{"type":"reconnect"}' }), '已发送重连指令。')}>
                <PlugZap size={14} />{t('重连')}</button>
              <button className="button button--secondary" type="button" disabled={!!busy || !s.enabled}
                onClick={() => void action(`sync-${s.id}`, () => request(`/api/realtime/subscriptions/${s.id}/action`, { method: 'POST', body: '{"type":"sync"}' }), '已触发立即同步。')}>
                <RefreshCw size={14} />{t('立即同步')}</button>
              <button className="button button--secondary button--danger" type="button" disabled={!!busy || !s.enabled}
                onClick={() => void action(`disable-${s.id}`, () => request(`/api/realtime/subscriptions/${s.id}/action`, { method: 'POST', body: '{"type":"disable"}' }), '已撤销该邮箱的实时同步。')}>
                <Unplug size={14} />{t('撤销')}</button>
            </div>
          </div>
        })}</div>}
    </div>

    {owner && <>
      <div className="realtime-section">
        <h3 className="realtime-section-title">{t('延迟统计')}</h3>
        <p className="realtime-note">{t('事件发现至索引完成（最近 1000 个批次，不含客户端显示）')} · P50 {percentile(measurements.map((m) => m.indexed_at - m.detected_at), .5)} · P95 {percentile(measurements.map((m) => m.indexed_at - m.detected_at), .95)} · P99 {percentile(measurements.map((m) => m.indexed_at - m.detected_at), .99)}</p>
      </div>
      <details className="realtime-admin-tools">
        <summary>{t('注册可信 VPS')}</summary>
        <p className="realtime-note">{t('从监听器生成文件中导入设备公钥。服务签名密钥通过 Worker Secrets 配置，不在此输入。')}</p>
        <form onSubmit={(e) => {
          e.preventDefault()
          let body: unknown
          try { body = JSON.parse(registration) }
          catch { setError(t('设备公钥 JSON 解析失败，请检查格式。')); return }
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(registerId)) { setError(t('设备标识只允许字母、数字、下划线和连字符，最长 64 字符。')); return }
          void action('register', () => request(`/api/realtime/admin/devices/${encodeURIComponent(registerId)}`, json(body)), '设备已注册或更新。')
        }}>
          <label className="realtime-field">{t('设备标识')}
            <input value={registerId} onChange={(e) => setRegisterId(e.target.value)} pattern="[A-Za-z0-9_-]{1,64}" required placeholder="vps-primary" />
          </label>
          <label className="realtime-field">{t('设备公钥 JSON')}
            <textarea value={registration} onChange={(e) => setRegistration(e.target.value)} required placeholder='{"name":"vps-primary",...}' />
          </label>
          <button className="button" type="submit" disabled={!!busy}>
            {busy === 'register' && <LoaderCircle className="spin" size={15} />}{t('注册或更新设备')}</button>
        </form>
        <ul className="realtime-device-list">{devices.map((d) => <li key={d.id} className="realtime-device">
          <span className="realtime-device-name">{d.name}</span>
          <span className={`realtime-pill realtime-pill--${d.enabled ? 'ok' : 'muted'}`}>{d.enabled ? t('可信') : t('已停用')}</span>
          <span className="realtime-note">{d.last_seen_at ? t('最后连接') + ' ' + time(d.last_seen_at * 1000) : t('尚未连接')}</span>
          <button className="button button--secondary" type="button" disabled={!!busy}
            onClick={() => void action(`device-${d.id}`, () => request(`/api/realtime/admin/devices/${d.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !d.enabled }) }), d.enabled ? '设备已停用。' : '设备已设为可信。')}>
            {d.enabled ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}{d.enabled ? t('停用设备') : t('信任设备')}
          </button>
        </li>)}</ul>
      </details>
    </>}

    <p className="realtime-note">{t('IMAP IDLE 支持由服务商实际能力决定；退化状态仍使用定时同步。Android 前台可实时更新，后台秒级推送尚未启用。')}</p>
  </section>
}
