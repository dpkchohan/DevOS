/**
 * Intelligent Model Router — Orchestration Phase 5.
 *
 * Philosophy: use the cheapest/fastest model that is good enough. Opus is
 * used only where its reasoning quality adds value (planning, review,
 * CRITICAL-tier work) — never as the default for every subtask, because
 * that only adds latency (Phase 17).
 *
 * Pure functions — no I/O. Callers supply the current `RoutingPolicy` and
 * (optionally) recent failure/reliability signals for a subtask; this
 * module never talks to the DB or network directly.
 *
 * @module domain/orchestration/router
 */

import type { RoutingPolicy, SubtaskAttempt, SubtaskSpec, TaskComplexity } from "./types";

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  // Primary coding worker first, then the retained fallbacks (Haiku fast
  // worker, MiniMax, and GPT-5.6 Luna) so cheap/simple work still avoids Opus.
  fastWorkers: [
    "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "auto/minimax",
    "gpt-5.6-luna",
  ],
  strongWorkers: ["bedrock/global.anthropic.claude-sonnet-5", "auto/minimax", "gpt-5.6-luna"],
  leadModel: "bedrock/global.anthropic.claude-opus-5",
  fallbackModel: "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
  maxAttemptsPerSubtask: 3,

  escalationLadder: [
    { attempt: 1, action: "same" },
    { attempt: 2, action: "same" },
    { attempt: 3, action: "escalate-worker" },
  ],
  preferCost: true,
  preferLatency: true,
  reviewEveryNSubtasks: 4,
};

/**
 * Choose the initial model for a subtask of a given complexity, per the
 * default philosophy: cheapest/fastest that is good enough.
 *
 *   TRIVIAL / SIMPLE  → fast worker (MiniMax 2.5 / GPT-5.6 Luna)
 *   MODERATE          → fast worker first (escalates on failure)
 *   COMPLEX           → strong worker (Sonnet 5 / Luna); Opus reserved for
 *                        planning/review, not first-pass implementation
 *   CRITICAL          → strong worker for implementation, Opus as
 *                        lead/reviewer (never as the sole silent chooser —
 *                        humanConfirmationRequired is a task-classifier flag
 *                        consumed by the caller, not enforced here)
 */
export function selectInitialModel(complexity: TaskComplexity, policy: RoutingPolicy): string {
  switch (complexity) {
    case "trivial":
    case "simple":
      return policy.fastWorkers[0] ?? policy.fallbackModel;
    case "moderate":
      return policy.fastWorkers[0] ?? policy.strongWorkers[0] ?? policy.fallbackModel;
    case "complex":
      return policy.strongWorkers[0] ?? policy.leadModel;
    case "critical":
      return policy.strongWorkers[0] ?? policy.leadModel;
    default:
      return policy.fallbackModel;
  }
}

/**
 * Decide the model for the NEXT attempt after a subtask attempt failed,
 * following the configured escalation ladder. Never retries forever —
 * returns null once `maxAttemptsPerSubtask` is exhausted, signaling the
 * caller to escalate to the lead model for diagnosis/replanning (Phase 6/7).
 */
export function selectEscalatedModel(
  subtask: SubtaskSpec,
  attempts: SubtaskAttempt[],
  policy: RoutingPolicy
): { model: string; escalateToLead: boolean } | null {
  const nextAttemptNumber = attempts.length + 1;
  if (nextAttemptNumber > policy.maxAttemptsPerSubtask) {
    return null;
  }

  const step =
    policy.escalationLadder.find((s) => s.attempt === nextAttemptNumber) ??
    policy.escalationLadder[policy.escalationLadder.length - 1];

  const lastModel = attempts[attempts.length - 1]?.model ?? subtask.recommendedModel;

  if (!step || step.action === "same") {
    return { model: lastModel, escalateToLead: false };
  }
  if (step.action === "escalate-worker") {
    const strong = policy.strongWorkers.find((m) => m !== lastModel) ?? policy.strongWorkers[0];
    return { model: strong ?? policy.leadModel, escalateToLead: false };
  }
  // escalate-lead
  return { model: policy.leadModel, escalateToLead: true };
}

/** Whether a subtask attempt count has exhausted the configured retry budget. */
export function isRetryBudgetExhausted(attempts: SubtaskAttempt[], policy: RoutingPolicy): boolean {
  return attempts.length >= policy.maxAttemptsPerSubtask;
}

/**
 * Whether a batch of completed subtasks warrants a lead review pass,
 * per `reviewEveryNSubtasks` (Phase 7 — review only meaningful groups,
 * not every single subtask, to avoid Opus-on-everything latency cost).
 */
export function shouldTriggerLeadReview(completedCount: number, policy: RoutingPolicy): boolean {
  if (policy.reviewEveryNSubtasks <= 0) return false;
  return completedCount > 0 && completedCount % policy.reviewEveryNSubtasks === 0;
}
