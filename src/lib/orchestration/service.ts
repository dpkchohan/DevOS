/**
 * Orchestration Service — wires planner, router, delegated executor, and
 * lead review into a single `runOrchestration()` entry point, persisting
 * state after every meaningful transition (Phase 13: survive restart).
 *
 * This is the ONLY module that touches both the pure `src/domain/orchestration/*`
 * logic and the DB/HTTP side effects — every other orchestration module stays
 * pure and unit-testable in isolation.
 *
 * @module lib/orchestration/service
 */

import { randomUUID } from "crypto";
import type {
  ModelCaller,
  OrchestrationRunState,
  SubtaskRuntimeState,
  TestRunner,
} from "@/domain/orchestration/types";
import { classifyTask } from "@/domain/orchestration/taskClassifier";
import { planTask } from "@/domain/orchestration/planner";
import { runSubtask } from "@/domain/orchestration/executor";
import { reviewCompletedSubtasks } from "@/domain/orchestration/review";
import { shouldTriggerLeadReview } from "@/domain/orchestration/router";
import { getRoutingPolicy } from "@/lib/db/orchestrationConfig";
import {
  createOrchestrationRun,
  getOrchestrationRun,
  listOrchestrationRuns,
  updateOrchestrationRun,
} from "@/lib/db/orchestrationRuns";

export interface RunOrchestrationArgs {
  task: string;
  repositorySummary?: string;
  callModel: ModelCaller;
  runTests?: TestRunner;
  signal?: AbortSignal;
  /** UX progress callback (Phase 11) — never receives raw model chain-of-thought. */
  onProgress?: (event: OrchestrationProgressEvent) => void;
}

export type OrchestrationProgressEvent =
  | { type: "classified"; complexity: string }
  | { type: "planned"; subtaskCount: number; plannedBy: string }
  | { type: "subtask_started"; id: string; model: string }
  | { type: "subtask_finished"; id: string; status: string }
  | { type: "review_started" }
  | { type: "review_finished"; approved: boolean; defectCount: number }
  | { type: "completed" }
  | { type: "failed"; error: string };

function nowIso(): string {
  return new Date().toISOString();
}

function persist(state: OrchestrationRunState, isNew: boolean): void {
  state.updatedAt = nowIso();
  if (isNew) createOrchestrationRun(state);
  else updateOrchestrationRun(state);
}

/** Topologically order subtasks by declared dependencies (Kahn's algorithm). */
function orderByDependencies(subtasks: SubtaskRuntimeState[]): SubtaskRuntimeState[] {
  const byId = new Map(subtasks.map((s) => [s.spec.id, s]));
  const remaining = new Set(subtasks.map((s) => s.spec.id));
  const ordered: SubtaskRuntimeState[] = [];
  const seen = new Set<string>();

  // Guard against cycles/unknown deps: fall back to declaration order for
  // anything that never becomes eligible, rather than looping forever.
  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const id of [...remaining]) {
      const s = byId.get(id);
      if (!s) {
        remaining.delete(id);
        continue;
      }
      const depsSatisfied = s.spec.dependencies.every((d) => seen.has(d) || !remaining.has(d));
      if (depsSatisfied) {
        ordered.push(s);
        seen.add(id);
        remaining.delete(id);
        progressed = true;
      }
    }
  }

  for (const id of remaining) {
    const s = byId.get(id);
    if (s) ordered.push(s);
  }
  return ordered;
}

/**
 * Run a full orchestration: classify → plan → execute subtasks (dependency
 * order, escalating on failure) → periodic lead review → completion.
 *
 * Never throws for expected failure modes (model call failure, test
 * failure) — those are captured in the persisted run state instead, so
 * callers (API routes, CLI) always get a terminal `OrchestrationRunState`
 * back. Persists after every subtask so a crash mid-run leaves a resumable
 * row (Phase 13); `resumeOrchestration` continues an interrupted run.
 */
export async function runOrchestration(args: RunOrchestrationArgs): Promise<OrchestrationRunState> {
  const { task, repositorySummary = "", callModel, runTests, signal, onProgress } = args;
  const policy = getRoutingPolicy();

  const classification = classifyTask(task);
  onProgress?.({ type: "classified", complexity: classification.complexity });

  const state: OrchestrationRunState = {
    id: randomUUID(),
    task,
    status: "planning",
    subtasks: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    leadModel: policy.leadModel,
  };
  persist(state, true);

  const plan = await planTask({
    task,
    classification,
    repositorySummary,
    policy,
    callModel,
    signal,
  });
  state.plan = plan;
  state.subtasks = plan.subtasks.map((spec) => ({ spec, status: "pending", attempts: [] }));
  state.status = "executing";
  onProgress?.({ type: "planned", subtaskCount: plan.subtasks.length, plannedBy: plan.plannedBy });
  persist(state, false);

  const ordered = orderByDependencies(state.subtasks);
  let completedSinceReview = 0;

  for (const subtaskState of ordered) {
    onProgress?.({
      type: "subtask_started",
      id: subtaskState.spec.id,
      model: subtaskState.spec.recommendedModel,
    });

    const { state: finishedState, needsLeadDiagnosis } = await runSubtask({
      subtask: subtaskState.spec,
      policy,
      callModel,
      runTests,
      signal,
    });

    // Merge the returned runtime state back into the persisted subtask entry
    // (runSubtask operates on its own copy).
    Object.assign(subtaskState, finishedState);
    onProgress?.({
      type: "subtask_finished",
      id: subtaskState.spec.id,
      status: subtaskState.status,
    });
    persist(state, false);

    if (subtaskState.status === "passed") {
      completedSinceReview += 1;
    } else if (needsLeadDiagnosis) {
      // Retry ladder exhausted, including the lead-model attempt — record the
      // failure and continue with remaining independent subtasks rather than
      // aborting the whole run (Phase 6: "do not blindly retry forever", but
      // also do not let one failed subtask sink unrelated work).
      state.error = state.error
        ? `${state.error}; ${subtaskState.spec.id} failed after escalation`
        : `${subtaskState.spec.id} failed after escalation`;
    }

    if (shouldTriggerLeadReview(completedSinceReview, policy)) {
      onProgress?.({ type: "review_started" });
      state.status = "reviewing";
      persist(state, false);

      const completed = state.subtasks.filter((s) => s.status === "passed");
      const review = await reviewCompletedSubtasks({
        leadModel: policy.leadModel,
        completedSubtasks: completed,
        callModel,
        signal,
      });
      state.reviewNotes = [...(state.reviewNotes ?? []), ...review.defects];
      onProgress?.({
        type: "review_finished",
        approved: review.approved,
        defectCount: review.defects.length,
      });
      state.status = "executing";
      persist(state, false);
      completedSinceReview = 0;
    }
  }

  const anyFailed = state.subtasks.some((s) => s.status === "failed" || s.status === "escalated");
  state.status = anyFailed ? "failed" : "completed";
  onProgress?.(
    anyFailed
      ? { type: "failed", error: state.error ?? "one or more subtasks failed" }
      : { type: "completed" }
  );
  persist(state, false);

  return state;
}

export function getRun(id: string): OrchestrationRunState | null {
  return getOrchestrationRun(id);
}

export function listRuns(limit?: number): OrchestrationRunState[] {
  return listOrchestrationRuns(limit);
}
