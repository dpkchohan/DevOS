/**
 * Model Router tests — Orchestration Phase 5.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ROUTING_POLICY,
  isRetryBudgetExhausted,
  selectEscalatedModel,
  selectInitialModel,
  shouldTriggerLeadReview,
} from "../../src/domain/orchestration/router.ts";
import type { SubtaskAttempt, SubtaskSpec } from "../../src/domain/orchestration/types.ts";

function makeSubtask(overrides: Partial<SubtaskSpec> = {}): SubtaskSpec {
  return {
    id: "s1",
    description: "desc",
    dependencies: [],
    complexity: "moderate",
    risk: 0.3,
    recommendedModel: "auto/minimax",

    files: [],
    acceptanceCriteria: [],
    tests: [],
    ...overrides,
  };
}

describe("selectInitialModel", () => {
  it("uses the fast worker for trivial/simple", () => {
    assert.equal(
      selectInitialModel("trivial", DEFAULT_ROUTING_POLICY),
      "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"
    );
    assert.equal(
      selectInitialModel("simple", DEFAULT_ROUTING_POLICY),
      "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"
    );
  });

  it("uses the strong worker for complex/critical, never the lead model directly", () => {
    const complex = selectInitialModel("complex", DEFAULT_ROUTING_POLICY);
    const critical = selectInitialModel("critical", DEFAULT_ROUTING_POLICY);
    assert.notEqual(complex, DEFAULT_ROUTING_POLICY.leadModel);
    assert.notEqual(critical, DEFAULT_ROUTING_POLICY.leadModel);
  });
});

describe("selectEscalatedModel", () => {
  it("retries the same model on attempt 2 per the default ladder", () => {
    const subtask = makeSubtask();
    const attempts: SubtaskAttempt[] = [
      { attempt: 1, model: "auto/minimax", startedAt: "t", outcome: "fail" },
    ];
    const result = selectEscalatedModel(subtask, attempts, DEFAULT_ROUTING_POLICY);
    assert.ok(result);
    assert.equal(result?.model, "auto/minimax");
    assert.equal(result?.escalateToLead, false);
  });

  it("escalates to a strong worker on attempt 3", () => {
    const subtask = makeSubtask();
    const attempts: SubtaskAttempt[] = [
      { attempt: 1, model: "auto/minimax", startedAt: "t", outcome: "fail" },
      { attempt: 2, model: "auto/minimax", startedAt: "t", outcome: "fail" },
    ];
    const result = selectEscalatedModel(subtask, attempts, DEFAULT_ROUTING_POLICY);
    assert.ok(result);
    assert.ok(DEFAULT_ROUTING_POLICY.strongWorkers.includes(result!.model));
  });

  it("returns null once maxAttemptsPerSubtask is exhausted", () => {
    const subtask = makeSubtask();
    const attempts: SubtaskAttempt[] = [
      { attempt: 1, model: "auto/minimax", startedAt: "t", outcome: "fail" },
      { attempt: 2, model: "auto/minimax", startedAt: "t", outcome: "fail" },
      {
        attempt: 3,
        model: "bedrock/global.anthropic.claude-sonnet-5",

        startedAt: "t",
        outcome: "fail",
      },
    ];

    const result = selectEscalatedModel(subtask, attempts, DEFAULT_ROUTING_POLICY);
    assert.equal(result, null);
  });
});

describe("isRetryBudgetExhausted", () => {
  it("is false below the max, true at/above it", () => {
    const twoAttempts: SubtaskAttempt[] = [
      { attempt: 1, model: "m", startedAt: "t" },
      { attempt: 2, model: "m", startedAt: "t" },
    ];
    assert.equal(isRetryBudgetExhausted(twoAttempts, DEFAULT_ROUTING_POLICY), false);
    const threeAttempts: SubtaskAttempt[] = [
      ...twoAttempts,
      { attempt: 3, model: "m", startedAt: "t" },
    ];
    assert.equal(isRetryBudgetExhausted(threeAttempts, DEFAULT_ROUTING_POLICY), true);
  });
});

describe("shouldTriggerLeadReview", () => {
  it("triggers only every reviewEveryNSubtasks completions", () => {
    const policy = { ...DEFAULT_ROUTING_POLICY, reviewEveryNSubtasks: 4 };
    assert.equal(shouldTriggerLeadReview(0, policy), false);
    assert.equal(shouldTriggerLeadReview(1, policy), false);
    assert.equal(shouldTriggerLeadReview(4, policy), true);
    assert.equal(shouldTriggerLeadReview(8, policy), true);
    assert.equal(shouldTriggerLeadReview(5, policy), false);
  });

  it("never triggers when disabled (0)", () => {
    const policy = { ...DEFAULT_ROUTING_POLICY, reviewEveryNSubtasks: 0 };
    assert.equal(shouldTriggerLeadReview(4, policy), false);
  });
});
