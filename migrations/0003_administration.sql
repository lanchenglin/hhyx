-- Additive upgrade: do not replace the existing administrator password or project data.
ALTER TABLE users ADD COLUMN username TEXT COLLATE NOCASE;
ALTER TABLE users ADD COLUMN system_role TEXT NOT NULL DEFAULT 'member' CHECK(system_role IN ('admin','member'));
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1));
ALTER TABLE users ADD COLUMN can_create_projects INTEGER NOT NULL DEFAULT 1 CHECK(can_create_projects IN (0,1));
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1));
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX users_username_unique ON users(username) WHERE username IS NOT NULL;
ALTER TABLE sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','archived','trashed'));
CREATE INDEX projects_lifecycle_updated ON projects(lifecycle,updated_at);
-- Only the original, recorded bootstrap account is promoted. No "first user wins" fallback.
UPDATE users SET system_role='admin',username='admin'
 WHERE id=(SELECT value FROM settings WHERE key='bootstrapped');
CREATE TABLE admin_audit (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL,
 target_id TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT,'admin_audit_append_only'); END;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT,'admin_audit_append_only'); END;
CREATE TRIGGER users_keep_admin BEFORE UPDATE OF system_role,disabled ON users
 WHEN OLD.system_role='admin' AND OLD.disabled=0 AND (NEW.system_role!='admin' OR NEW.disabled=1)
 AND (SELECT COUNT(*) FROM users WHERE system_role='admin' AND disabled=0)<=1
 BEGIN SELECT RAISE(ABORT,'last_active_admin'); END;
CREATE TRIGGER users_no_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,'disable_accounts_instead'); END;
CREATE TABLE admin_operations (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 result TEXT NOT NULL, created_at TEXT NOT NULL
);
-- Optimistic lock for all site-level security/configuration changes.
INSERT OR IGNORE INTO settings(key,value) VALUES('admin_revision','0');
