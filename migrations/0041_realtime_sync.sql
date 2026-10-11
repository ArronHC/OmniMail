-- Optional realtime enhancement. Existing accounts remain opt-out.
CREATE TABLE realtime_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  window_at INTEGER NOT NULL DEFAULT 0,
  request_day INTEGER NOT NULL DEFAULT 0,
  daily_requests INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE realtime_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('gmail','microsoft','qq','naver','yandex')),
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES realtime_devices(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  generation INTEGER NOT NULL DEFAULT 1,
  last_action_at INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER,
  last_sync_at INTEGER,
  last_duration_ms INTEGER,
  listener_state TEXT NOT NULL DEFAULT 'offline',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, account_id)
);
CREATE INDEX idx_realtime_device ON realtime_subscriptions(device_id, enabled, id);
CREATE INDEX idx_realtime_user ON realtime_subscriptions(user_id, id);
CREATE TABLE realtime_nonces (
  device_id TEXT NOT NULL REFERENCES realtime_devices(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, nonce)
);
CREATE INDEX idx_realtime_nonce_expiry ON realtime_nonces(expires_at);
CREATE TABLE realtime_jobs (
  subscription_id TEXT PRIMARY KEY REFERENCES realtime_subscriptions(id) ON DELETE CASCADE,
  requested_seq INTEGER NOT NULL DEFAULT 0,
  completed_seq INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  queued_until INTEGER NOT NULL DEFAULT 0,
  sync_day INTEGER NOT NULL DEFAULT 0,
  daily_syncs INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_realtime_pending ON realtime_jobs(next_attempt_at, lease_until);
CREATE TABLE realtime_measurements (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES realtime_subscriptions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_realtime_measurement_retention ON realtime_measurements(created_at);
