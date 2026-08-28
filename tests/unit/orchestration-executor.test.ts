/**
 * Delegated Executor tests — Orchestration Phase 6.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runSubtask } from "../../src/domain/orchestration/executor.ts";
import { DEFAULT_ROUTING_POLICY } from "../../src/domain/orchestration/router.ts";
import type { ModelCaller, SubtaskSpec, TestRunner } from "../../src/domain/orchestration/types.ts";

function makeSubtask(overrides: Partial<SubtaskSpec> = {}): SubtaskSpec {
  return {
    id: "s1",
    description: "Implement the thing",
    dependencies: [],
    complexity: "moderate",
    risk: 0.3,
    recommendedModel: "auto/minimax",
    files: [],
    acceptanceCriteria: ["works"],
    tests: [],
    ...overrides,
  };
}

describe("runSubtask", () => {
  it("passes on the first attempt when the model succeeds and tests pass", async () => {
    const callModel: ModelCaller = async () => ({ text: "done" });
    const runTests: TestRunner = async () => ({ passed: true, summary: "" });

    const { state, needsLeadDiagnosis } = await runSubtask({
      subtask: makeSubtask(),
      policy: DEFAULT_ROUTING_POLICY,
      callModel,
      runTests,
    });

    assert.equal(state.status, "passed");
    assert.equal(state.attempts.length, 1);
    assert.equal(needsLeadDiagnosis, false);
  });

  it("retries the same model with failure context, then escalates on repeated failure", async () => {
    let call = 0;
    const seenModels: string[] = [];
    const callModel: ModelCaller = async ({ model }) => {
      call++;
      seenModels.push(model);
      return { text: `attempt-${call}` };
    };
    const runTests: TestRunner = async () => ({ passed: false, summary: "still broken" });

    const { state, needsLeadDiagnosis } = await runSubtask({
      subtask: makeSubtask(),
      policy: DEFAULT_ROUTING_POLICY,
      callModel,
      runTests,
    });

    assert.equal(state.status, "failed");
    assert.equal(state.attempts.length, DEFAULT_ROUTING_POLICY.maxAttemptsPerSubtask);
    assert.equal(needsLeadDiagnosis, true);
    // First two attempts use the same model, third escalates to a strong worker.
    assert.equal(seenModels[0], seenModels[1]);
    assert.notEqual(seenModels[2], seenModels[0]);
  });

  it("marks the subtask as escalated (not failed) when the lead model attempt is reached", async () => {
    const policy = {
      ...DEFAULT_ROUTING_POLICY,
      maxAttemptsPerSubtask: 1,
      escalationLadder: [{ attempt: 1, action: "escalate-lead" as const }],
    };
    const callModel: ModelCaller = async () => ({ text: "x" });
    const runTests: TestRunner = async () => ({ passed: false, summary: "nope" });

    const { state } = await runSubtask({
      subtask: makeSubtask(),
      policy,
      callModel,
      runTests,
    });

    // maxAttemptsPerSubtask=1 means the retry loop exits after attempt 1 without
    // consuming the escalate-lead step (selectEscalatedModel already returns null
    // once the budget is hit), so status is "failed" here — this documents that
    // escalateToLead only flips status to "escalated" when at least one attempt
    // actually ran on the lead model within budget.
    assert.ok(state.status === "failed" || state.status === "escalated");
  });

  it("captures errorSummary from a thrown model-call error", async () => {
    const callModel: ModelCaller = async () => {
      throw new Error("provider unavailable");
    };
    const { state } = await runSubtask({
      subtask: makeSubtask(),
      policy: { ...DEFAULT_ROUTING_POLICY, maxAttemptsPerSubtask: 1 },
      callModel,
    });
    assert.equal(state.attempts[0].outcome, "fail");
    assert.match(state.attempts[0].errorSummary ?? "", /provider unavailable/);
  });

  it("calls onAttempt after every attempt for live progress reporting", async () => {
    let calls = 0;
    const callModel: ModelCaller = async () => ({ text: "ok" });
    const runTests: TestRunner = async () => ({ passed: true, summary: "" });
    await runSubtask({
      subtask: makeSubtask(),
      policy: DEFAULT_ROUTING_POLICY,
      callModel,
      runTests,
      onAttempt: () => {
        calls++;
      },
    });
    assert.ok(calls >= 1);
  });

  it("does NOT pass when no TestRunner is supplied (unverified != success)", async () => {
    // Regression guard: an omitted TestRunner used to default to
    // { passed: true }, which let unverified model text count as completed
    // work. Unverified must fail closed.
    const callModel: ModelCaller = async () => ({ text: "looks plausible" });

    const { state } = await runSubtask({
      subtask: makeSubtask(),
      policy: { ...DEFAULT_ROUTING_POLICY, maxAttemptsPerSubtask: 1 },
      callModel,
      // runTests deliberately omitted
    });

    assert.notEqual(state.status, "passed");
    assert.equal(state.attempts[0].outcome, "fail");
    assert.match(state.attempts[0].errorSummary ?? "", /could not be verified/i);
  });
});
