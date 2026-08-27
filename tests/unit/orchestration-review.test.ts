/**
 * Lead Review tests — Orchestration Phase 7.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { reviewCompletedSubtasks } from "../../src/domain/orchestration/review.ts";
import type { ModelCaller, SubtaskRuntimeState } from "../../src/domain/orchestration/types.ts";

function makeCompleted(id: string, result: string): SubtaskRuntimeState {
  return {
    spec: {
      id,
      description: "d",
      dependencies: [],
      complexity: "moderate",
      risk: 0.3,
      recommendedModel: "minimax-m2.5",
      files: [],
      acceptanceCriteria: [],
      tests: [],
    },
    status: "passed",
    attempts: [],
    result,
  };
}

describe("reviewCompletedSubtasks", () => {
  it("parses an approved review with no defects", async () => {
    const callModel: ModelCaller = async () => ({
      text: JSON.stringify({ approved: true, defects: [] }),
    });
    const result = await reviewCompletedSubtasks({
      leadModel: "claude-opus-5",
      completedSubtasks: [makeCompleted("a", "impl a")],
      callModel,
    });
    assert.equal(result.approved, true);
    assert.deepEqual(result.defects, []);
  });

  it("parses a rejected review with defects", async () => {
    const callModel: ModelCaller = async () => ({
      text: JSON.stringify({ approved: false, defects: ["Missing null check in foo()"] }),
    });
    const result = await reviewCompletedSubtasks({
      leadModel: "claude-opus-5",
      completedSubtasks: [makeCompleted("a", "impl a")],
      callModel,
    });
    assert.equal(result.approved, false);
    assert.equal(result.defects.length, 1);
  });

  it("degrades to approved with no defects when the model call throws", async () => {
    const callModel: ModelCaller = async () => {
      throw new Error("timeout");
    };
    const result = await reviewCompletedSubtasks({
      leadModel: "claude-opus-5",
      completedSubtasks: [makeCompleted("a", "impl a")],
      callModel,
    });
    assert.equal(result.approved, true);
    assert.deepEqual(result.defects, []);
  });

  it("degrades to approved with no defects on unparsable output", async () => {
    const callModel: ModelCaller = async () => ({ text: "not json" });
    const result = await reviewCompletedSubtasks({
      leadModel: "claude-opus-5",
      completedSubtasks: [makeCompleted("a", "impl a")],
      callModel,
    });
    assert.equal(result.approved, true);
  });
});
