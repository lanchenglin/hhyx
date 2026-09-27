-- Additive only. Preserve project data, old policies, reports, signatures and credentials.
ALTER TABLE ai_jobs ADD COLUMN continuation TEXT;
ALTER TABLE ai_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_jobs ADD COLUMN call_limit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_jobs ADD COLUMN usage_log TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_jobs ADD COLUMN lease_token TEXT;
