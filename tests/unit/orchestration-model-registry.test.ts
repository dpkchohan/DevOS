/**
 * Model Capability Registry tests — Orchestration Phase 2.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getModelCapability,
  listModelCapabilities,
  listModelsForRole,
  ratingScore,
  registerModelCapability,
} from "../../src/domain/orchestration/modelRegistry.ts";

describe("model capability registry", () => {
  it("has default entries for the five orchestration-brief models", () => {
    for (const id of [
      "bedrock/global.anthropic.claude-opus-5",
      "bedrock/global.anthropic.claude-sonnet-5",
      "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
      "gpt-5.6-luna",
      "auto/minimax",
    ]) {
      assert.ok(getModelCapability(id), `expected a registry entry for ${id}`);
    }
  });

  it("lists Opus 5 under lead/planner/reviewer roles", () => {
    const opus = getModelCapability("bedrock/global.anthropic.claude-opus-5");
    assert.ok(opus);
    assert.ok(opus?.roles.includes("lead"));
    assert.ok(opus?.roles.includes("planner"));
    assert.ok(opus?.roles.includes("reviewer"));
  });

  it("lists models by role", () => {
    const leads = listModelsForRole("lead");
    assert.ok(leads.some((m) => m.id === "bedrock/global.anthropic.claude-opus-5"));
    const workers = listModelsForRole("worker");
    assert.ok(workers.some((m) => m.id === "auto/minimax"));
  });

  it("ratingScore maps levels to a 0..1 numeric scale monotonically", () => {
    assert.ok(ratingScore("very-low") < ratingScore("low"));
    assert.ok(ratingScore("low") < ratingScore("medium"));
    assert.ok(ratingScore("medium") < ratingScore("high"));
    assert.ok(ratingScore("high") < ratingScore("very-high"));
  });

  it("allows runtime registration/override without mutating the module defaults for other ids", () => {
    registerModelCapability({
      id: "test-custom-model",
      displayName: "Test Custom Model",
      provider: "custom",
      family: "custom",
      reasoning: "medium",
      coding: "medium",
      toolUse: "medium",
      streaming: true,
      latency: "medium",
      cost: "medium",
      reliability: "medium",
      roles: ["worker"],
    });
    assert.ok(getModelCapability("test-custom-model"));
    assert.ok(listModelCapabilities().some((m) => m.id === "test-custom-model"));
    assert.ok(getModelCapability("bedrock/global.anthropic.claude-opus-5"));
  });
});
