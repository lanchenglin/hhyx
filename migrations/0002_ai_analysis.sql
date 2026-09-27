-- Incremental migration. Never modify 0001 or delete existing business data.
CREATE TABLE IF NOT EXISTS ai_jobs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), actor_id TEXT NOT NULL,
 kind TEXT NOT NULL, target_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
 snapshot TEXT NOT NULL, engine TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 lease_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, finished_at TEXT,
 error_code TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS ai_jobs_dispatch ON ai_jobs(status,lease_until,created_at);
CREATE INDEX IF NOT EXISTS ai_jobs_project ON ai_jobs(project_id,created_at);
CREATE TRIGGER IF NOT EXISTS ai_jobs_input_immutable BEFORE UPDATE OF snapshot,snapshot_hash,engine,project_id,actor_id,kind,target_id ON ai_jobs BEGIN SELECT RAISE(ABORT,'ai_input_immutable'); END;
CREATE TABLE IF NOT EXISTS ai_reports (
 job_id TEXT PRIMARY KEY REFERENCES ai_jobs(id), project_id TEXT NOT NULL REFERENCES projects(id),
 report TEXT NOT NULL, report_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ai_report_no_update BEFORE UPDATE ON ai_reports BEGIN SELECT RAISE(ABORT,'ai_report_append_only'); END;
CREATE TRIGGER IF NOT EXISTS ai_report_no_delete BEFORE DELETE ON ai_reports BEGIN SELECT RAISE(ABORT,'ai_report_append_only'); END;
