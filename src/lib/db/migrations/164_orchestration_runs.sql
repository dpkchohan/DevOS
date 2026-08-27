-- 164_orchestration_runs.sql
-- Hierarchical planner/router orchestration state (Phase 13/14).
-- One row per orchestration run; subtasks/plan/attempts are stored as JSON
-- blobs (small, bounded per-run — a dedicated relational schema would be
-- over-engineering for what is fundamentally a single run's working state,
-- consistent with how config_audit_log/model_intelligence store JSON columns
-- elsewhere in this schema).
CREATE TABLE IF NOT EXISTS orchestration_runs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  lead_model TEXT NOT NULL,
  plan_json TEXT,
  subtasks_json TEXT NOT NULL DEFAULT '[]',
  review_notes_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status ON orchestration_runs(status);
CREATE INDEX IF NOT EXISTS idx_orchestration_runs_updated ON orchestration_runs(updated_at);
