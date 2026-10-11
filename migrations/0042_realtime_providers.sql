-- SQLite requires a table rebuild to extend the provider CHECK constraint.
-- Keep dependent rows explicitly: D1 enforces foreign keys, and dropping the
-- original subscriptions table would otherwise cascade-delete jobs/measurements.
-- Run the entire migration atomically (as with the other D1 migrations).
CREATE TABLE realtime_jobs_0042_backup AS SELECT * FROM realtime_jobs;
CREATE TABLE realtime_measurements_0042_backup AS SELECT * FROM realtime_measurements;
DELETE FROM realtime_jobs;
DELETE FROM realtime_measurements;

CREATE TABLE realtime_subscriptions_0042 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('gmail','microsoft','qq','naver','yandex','icloud','linuxdo')),
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
INSERT INTO realtime_subscriptions_0042 (
  id, user_id, provider, account_id, device_id, enabled, generation,
  last_action_at, last_event_at, last_sync_at, last_duration_ms,
  listener_state, last_error, updated_at
)
SELECT id, user_id, provider, account_id, device_id, enabled, generation,
       last_action_at, last_event_at, last_sync_at, last_duration_ms,
       listener_state, last_error, updated_at
FROM realtime_subscriptions;

DROP TABLE realtime_subscriptions;
ALTER TABLE realtime_subscriptions_0042 RENAME TO realtime_subscriptions;
CREATE INDEX idx_realtime_device ON realtime_subscriptions(device_id, enabled, id);
CREATE INDEX idx_realtime_user ON realtime_subscriptions(user_id, id);

INSERT INTO realtime_jobs (
  subscription_id, requested_seq, completed_seq, requested_at, detected_at,
  received_at, lease_id, lease_until, next_attempt_at, queued_until,
  sync_day, daily_syncs, attempts
)
SELECT subscription_id, requested_seq, completed_seq, requested_at, detected_at,
       received_at, lease_id, lease_until, next_attempt_at, queued_until,
       sync_day, daily_syncs, attempts
FROM realtime_jobs_0042_backup;
INSERT INTO realtime_measurements (
  id, subscription_id, provider, detected_at, received_at, indexed_at,
  duration_ms, result, created_at
)
SELECT id, subscription_id, provider, detected_at, received_at, indexed_at,
       duration_ms, result, created_at
FROM realtime_measurements_0042_backup;
DROP TABLE realtime_jobs_0042_backup;
DROP TABLE realtime_measurements_0042_backup;
