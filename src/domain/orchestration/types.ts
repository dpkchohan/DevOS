/**
 * Orchestration domain types — Hierarchical Planner / Model Router.
 *
 * Pure type definitions shared by the model capability registry, task
 * classifier, router, planner, and delegated executor. No I/O, no side
 * effects — mirrors the existing `src/domain/pipeline.ts` convention of
 * keeping the orchestration *logic* pure and delegating all network/DB
 * access to caller-injected functions (see `ModelCaller`, `TestRunner`).
 *
 * @module domain/orchestration/types
 */

// ---------------------------------------------------------------------------
// Model capability registry
// ---------------------------------------------------------------------------

/** Coarse-grained routing heuristic — NOT a scientific benchmark result. */
export type RatingLevel = "very-low" | "low" | "medium" | "high" | "very-high";

/** Roles a model is suitable for within the orchestration pipeline. */
export type ModelRole = "lead" | "planner" | "reviewer" | "worker" | "fallback";

export interface ModelCapabilityMetadata {
  /** Canonical model id as routed by OmniRoute (e.g. "claude-opus-5"). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Provider id this entry assumes by default (e.g. "bedrock", "anthropic"). */
  provider: string;
  /** Model family for grouping/fallback purposes. */
  family: string;
  /** Context window in tokens, if known. */
  contextLength?: number;
  reasoning: RatingLevel;
  coding: RatingLevel;
  toolUse: RatingLevel;
  streaming: boolean;
  /** Relative latency heuristic — lower is faster. */
  latency: RatingLevel;
  /** Relative cost heuristic — lower is cheaper. */
  cost: RatingLevel;
  /** Historical reliability heuristic, refined over time by observed outcomes. */
  reliability: RatingLevel;
  /** Roles this model is well-suited for. */
  roles: ModelRole[];
  /** Free-text operator notes (never used for security decisions). */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Task classification
// ---------------------------------------------------------------------------

export type TaskComplexity = "trivial" | "simple" | "moderate" | "complex" | "critical";

export interface TaskClassification {
  complexity: TaskComplexity;
  /** Estimated number of files likely touched by the task. */
  estimatedFileCount: number;
  /** Whether the task appears to change architecture/cross-cutting concerns. */
  architectureImpact: boolean;
  /** 0..1 risk heuristic (destructive/security-sensitive changes score higher). */
  risk: number;
  reasoningRequired: boolean;
  codingRequired: boolean;
  testingRequired: boolean;
  repoExplorationRequired: boolean;
  externalResearchRequired: boolean;
  humanConfirmationRequired: boolean;
  /** Keyword/heuristic signals that produced this classification (for UX/debug). */
  signals: string[];
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface SubtaskSpec {
  id: string;
  description: string;
  /** IDs of subtasks that must complete before this one may start. */
  dependencies: string[];
  complexity: TaskComplexity;
  risk: number;
  recommendedModel: string;
  files: string[];
  acceptanceCriteria: string[];
  tests: string[];
}

export interface OrchestrationPlan {
  task: string;
  architectureSummary: string;
  subtasks: SubtaskSpec[];
  /** Model that produced this plan (e.g. "claude-opus-5" or "rule-based-fallback"). */
  plannedBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type SubtaskStatus =
  "pending" | "in_progress" | "passed" | "failed" | "escalated" | "skipped";

export interface SubtaskAttempt {
  attempt: number;
  model: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: "pass" | "fail";
  errorSummary?: string;
  /** Latency in ms, when known. */
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export interface SubtaskRuntimeState {
  spec: SubtaskSpec;
  status: SubtaskStatus;
  attempts: SubtaskAttempt[];
  result?: string;
}

export type OrchestrationRunStatus =
  "planning" | "executing" | "reviewing" | "completed" | "failed" | "canceled";

export interface OrchestrationRunState {
  id: string;
  task: string;
  status: OrchestrationRunStatus;
  plan?: OrchestrationPlan;
  subtasks: SubtaskRuntimeState[];
  createdAt: string;
  updatedAt: string;
  leadModel: string;
  reviewNotes?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Retry / escalation policy
// ---------------------------------------------------------------------------

export interface EscalationStep {
  /** Attempt number this step applies to (1-based). */
  attempt: number;
  /** "same" retries the same model with failure context; otherwise a role. */
  action: "same" | "escalate-worker" | "escalate-lead";
}

export interface RoutingPolicy {
  /** Default worker models tried in order for MODERATE/COMPLEX before escalation. */
  fastWorkers: string[];
  strongWorkers: string[];
  leadModel: string;
  fallbackModel: string;
  maxAttemptsPerSubtask: number;
  escalationLadder: EscalationStep[];
  /** Cost preference nudges routing toward cheaper models when true. */
  preferCost: boolean;
  /** Latency preference nudges routing toward faster models when true. */
  preferLatency: boolean;
  reviewEveryNSubtasks: number;
}

// ---------------------------------------------------------------------------
// Caller-injected side-effect seams (kept OUT of pure domain functions)
// ---------------------------------------------------------------------------

export interface ModelCallResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

/** Caller-provided function that performs one model completion call. */
export type ModelCaller = (args: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}) => Promise<ModelCallResult>;

export interface TestRunResult {
  passed: boolean;
  summary: string;
}

/** Caller-provided function that runs validation/tests for a subtask. */
export type TestRunner = (subtask: SubtaskSpec, artifact: string) => Promise<TestRunResult>;
