PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, phone TEXT, sms_opt_in INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, reauth_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
 revision INTEGER NOT NULL, last_operation TEXT NOT NULL, audit_head TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_access (
 project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY(project_id,user_id)
);
CREATE TABLE IF NOT EXISTS operations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
 actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL,
 summary TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL,
 previous_hash TEXT NOT NULL, record_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(project_id,revision)
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
CREATE TABLE IF NOT EXISTS invites (
 token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), member_id TEXT NOT NULL,
 email TEXT NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), uploader_id TEXT NOT NULL,
 name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL,
 title TEXT NOT NULL, body TEXT NOT NULL, target TEXT NOT NULL, severity TEXT NOT NULL,
 created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,created_at);
CREATE TABLE IF NOT EXISTS channel_settings (
 project_id TEXT PRIMARY KEY REFERENCES projects(id), wecom_encrypted TEXT,
 enabled INTEGER NOT NULL DEFAULT 0, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT,
 channel TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
 target TEXT NOT NULL, severity TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 next_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT,
 error TEXT, provider_receipt TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,next_at);
CREATE TABLE IF NOT EXISTS reminder_keys (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
