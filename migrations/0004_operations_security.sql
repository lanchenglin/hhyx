-- Additive upgrade; passwords, business records and existing approvals are retained.
ALTER TABLE sessions ADD COLUMN mfa_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN mfa_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE mfa_credentials (
 user_id TEXT PRIMARY KEY REFERENCES users(id), secret_encrypted TEXT,
 version INTEGER NOT NULL DEFAULT 0, last_counter INTEGER NOT NULL DEFAULT -1,
 pending_encrypted TEXT, pending_session TEXT, pending_expires INTEGER,
 updated_at TEXT NOT NULL
);
CREATE TABLE mfa_recovery_codes (
 user_id TEXT NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL,
 version INTEGER NOT NULL, used_at TEXT, PRIMARY KEY(user_id,code_hash)
);
ALTER TABLE channel_settings ADD COLUMN inherit_global INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_settings ADD COLUMN global_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE sms_dispatches (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, utc_day TEXT NOT NULL,
 created_at TEXT NOT NULL, config_revision INTEGER NOT NULL
);
CREATE INDEX sms_daily ON sms_dispatches(utc_day,user_id);
CREATE TABLE admin_alerts (
 id TEXT PRIMARY KEY, severity TEXT NOT NULL, title TEXT NOT NULL,
 details TEXT NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT, acknowledged_by TEXT
);
CREATE TABLE backup_jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('backup','drill')),
 source_id TEXT, status TEXT NOT NULL DEFAULT 'queued', actor_id TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'snapshot', state TEXT NOT NULL DEFAULT '{}',
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 key_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 finished_at TEXT, error TEXT, manifest_key TEXT, report TEXT,
 request_key TEXT UNIQUE
);
CREATE INDEX backup_dispatch ON backup_jobs(status,created_at);
INSERT OR IGNORE INTO settings(key,value) VALUES('installation_id',lower(hex(randomblob(16))));
