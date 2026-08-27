/**
 * Model Capability Registry — Orchestration heuristics.
 *
 * Hand-maintained routing heuristics for the small set of models the
 * hierarchical planner/router (see `docs/architecture/orchestration.md`)
 * actively assigns roles to. These ratings are ROUTING HEURISTICS, not
 * scientific benchmark results — see Phase 2 of the orchestration build:
 * they must stay configurable (via `setModelCapabilityOverride` /
 * `getModelCapabilityOverride` in `src/lib/db/orchestrationConfig.ts`) and
 * are never treated as ground truth for anything security-relevant.
 *
 * This module is intentionally separate from the large, generic
 * `src/lib/modelCapabilities.ts` (tool-calling/vision/context-window
 * resolution for EVERY model OmniRoute can route to). That module answers
 * "can this model do X at the API level"; this one answers "how good is
 * this model at coding/reasoning/etc., for orchestration role assignment".
 *
 * @module domain/orchestration/modelRegistry
 */

import type { ModelCapabilityMetadata, ModelRole, RatingLevel } from "./types";

/**
 * Default capability metadata for the models named in the orchestration
 * build brief. Additional models can be registered at runtime via
 * `registerModelCapability` (e.g. from DB-backed operator overrides) without
 * modifying this file.
 */
const DEFAULT_MODEL_CAPABILITIES: ModelCapabilityMetadata[] = [
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    provider: "bedrock",
    family: "claude-opus",
    contextLength: 1_000_000,
    reasoning: "very-high",
    coding: "very-high",
    toolUse: "very-high",
    streaming: true,
    latency: "high",
    cost: "high",
    reliability: "high",
    roles: ["lead", "planner", "reviewer"],
    notes:
      "Lead architect/planner/reviewer. Bedrock inference-profile id: us.anthropic.claude-opus-5.",
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    provider: "bedrock",
    family: "claude-sonnet",
    contextLength: 1_000_000,
    reasoning: "high",
    coding: "high",
    toolUse: "high",
    streaming: true,
    latency: "medium",
    cost: "medium",
    reliability: "high",
    roles: ["worker", "reviewer"],
    notes:
      "Strong worker for COMPLEX subtasks. Bedrock inference-profile id: us.anthropic.claude-sonnet-5.",
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    provider: "bedrock",
    family: "claude-haiku",
    contextLength: 200_000,
    reasoning: "medium",
    coding: "medium",
    toolUse: "medium",
    streaming: true,
    latency: "very-low",
    cost: "low",
    reliability: "high",
    roles: ["worker", "fallback"],
    notes:
      "Fast/simple fallback for TRIVIAL/SIMPLE work. Bedrock inference-profile id: us.anthropic.claude-haiku-4-5-20251001-v1:0. Do NOT assume Haiku 4.6 exists on Bedrock.",
  },
  {
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    provider: "openai",
    family: "gpt-5.6",
    contextLength: 272_000,
    reasoning: "high",
    coding: "high",
    toolUse: "high",
    streaming: true,
    latency: "low",
    cost: "low",
    reliability: "high",
    roles: ["worker"],
    notes:
      "Fast/high-quality worker. Must use the correct inference profile, not on-demand throughput.",
  },
  {
    id: "minimax-m2.5",
    displayName: "MiniMax 2.5",
    provider: "minimax",
    family: "minimax",
    contextLength: 200_000,
    reasoning: "high",
    coding: "high",
    toolUse: "medium",
    streaming: true,
    latency: "very-low",
    cost: "low",
    reliability: "medium",
    roles: ["worker"],
    notes: "Fast worker — default for normal implementation/repetitive coding.",
  },
];

const registry = new Map<string, ModelCapabilityMetadata>(
  DEFAULT_MODEL_CAPABILITIES.map((m) => [m.id, m])
);

/** Register or override a model's capability metadata at runtime. */
export function registerModelCapability(entry: ModelCapabilityMetadata): void {
  registry.set(entry.id, entry);
}

export function getModelCapability(modelId: string): ModelCapabilityMetadata | undefined {
  return registry.get(modelId);
}

export function listModelCapabilities(): ModelCapabilityMetadata[] {
  return [...registry.values()];
}

const RATING_SCORE: Record<RatingLevel, number> = {
  "very-low": 0,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  "very-high": 1,
};

export function ratingScore(level: RatingLevel): number {
  return RATING_SCORE[level];
}

/** List models registered for a given orchestration role. */
export function listModelsForRole(role: ModelRole): ModelCapabilityMetadata[] {
  return listModelCapabilities().filter((m) => m.roles.includes(role));
}
