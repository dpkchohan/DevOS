/**
 * db/orchestrationRuns.ts — persistence for hierarchical planner/router runs.
 *
 * Backs Orchestration Phase 13 (survive restart/crash) and Phase 14 (reuse
 * existing SQLite, no new database, additive migration only — see
 * migrations/164_orchestration_runs.sql). Follows the established
 * `rowToCamel` + JSON-column convention used across `db/*.ts` (e.g.
 * `modelIntelligence.ts`).
 *
 * @module lib/db/orchestrationRuns
 */

import { getDbInstance, rowToCamel } from "./core";
import type { OrchestrationRunState, OrchestrationRunStatus } from "@/domain/orchestration/types";

interface OrchestrationRunRow {
  id: string;
  task: string;
  status: OrchestrationRunStatus;
  leadModel: string;
  plan: string | null;
  subtasks: string;
  reviewNotes: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToState(row: Record<string, unknown>): OrchestrationRunState {
  const camel = rowToCamel(row) as unknown as OrchestrationRunRow;
  let plan: OrchestrationRunState["plan"];
  try {
    plan = camel.plan ? JSON.parse(camel.plan) : undefined;
  } catch {
    plan = undefined;
  }
  let subtasks: OrchestrationRunState["subtasks"] = [];
  try {
    subtasks = camel.subtasks ? JSON.parse(camel.subtasks) : [];
  } catch {
    subtasks = [];
  }
  let reviewNotes: string[] | undefined;
  try {
    reviewNotes = camel.reviewNotes ? JSON.parse(camel.reviewNotes) : undefined;
  } catch {
    reviewNotes = undefined;
  }

  return {
    id: camel.id,
    task: camel.task,
    status: camel.status,
    leadModel: camel.leadModel,
    plan,
    subtasks,
    reviewNotes,
    error: camel.error ?? undefined,
    createdAt: camel.createdAt,
    updatedAt: camel.updatedAt,
  };
}

export function createOrchestrationRun(state: OrchestrationRunState): void {
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO orchestration_runs
       (id, task, status, lead_model, plan_json, subtasks_json, review_notes_json, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    state.id,
    state.task,
    state.status,
    state.leadModel,
    state.plan ? JSON.stringify(state.plan) : null,
    JSON.stringify(state.subtasks ?? []),
    state.reviewNotes ? JSON.stringify(state.reviewNotes) : null,
    state.error ?? null,
    state.createdAt,
    state.updatedAt
  );
}

export function updateOrchestrationRun(state: OrchestrationRunState): void {
  const db = getDbInstance();
  db.prepare(
    `UPDATE orchestration_runs
     SET status = ?, plan_json = ?, subtasks_json = ?, review_notes_json = ?, error = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    state.status,
    state.plan ? JSON.stringify(state.plan) : null,
    JSON.stringify(state.subtasks ?? []),
    state.reviewNotes ? JSON.stringify(state.reviewNotes) : null,
    state.error ?? null,
    state.updatedAt,
    state.id
  );
}

export function getOrchestrationRun(id: string): OrchestrationRunState | null {
  const db = getDbInstance();
  const row = db.prepare(`SELECT * FROM orchestration_runs WHERE id = ?`).get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToState(row) : null;
}

export function listOrchestrationRuns(limit = 50): OrchestrationRunState[] {
  const db = getDbInstance();
  const rows = db
    .prepare(`SELECT * FROM orchestration_runs ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToState);
}

/** Runs left in a non-terminal state by a crash/restart (Phase 13 resume). */
export function listResumableOrchestrationRuns(): OrchestrationRunState[] {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT * FROM orchestration_runs WHERE status IN ('planning', 'executing', 'reviewing') ORDER BY updated_at ASC`
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToState);
}

export function deleteOrchestrationRun(id: string): boolean {
  const db = getDbInstance();
  const result = db.prepare(`DELETE FROM orchestration_runs WHERE id = ?`).run(id);
  return (result.changes ?? 0) > 0;
}
