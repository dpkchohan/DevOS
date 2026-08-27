/**
 * Planner tests — Orchestration Phase 4.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planTask } from "../../src/domain/orchestration/planner.ts";
import { DEFAULT_ROUTING_POLICY } from "../../src/domain/orchestration/router.ts";
import { classifyTask } from "../../src/domain/orchestration/taskClassifier.ts";
import type { ModelCaller } from "../../src/domain/orchestration/types.ts";

describe("planTask", () => {
  it("falls back to a rule-based single-subtask plan when no callModel is supplied", async () => {
    const classification = classifyTask("Add a small helper function.");
    const plan = await planTask({
      task: "Add a small helper function.",
      classification,
      repositorySummary: "",
      policy: DEFAULT_ROUTING_POLICY,
    });
    assert.equal(plan.plannedBy, "rule-based-fallback");
    assert.equal(plan.subtasks.length, 1);
  });

  it("parses a well-formed JSON plan from the lead model", async () => {
    const callModel: ModelCaller = async () => ({
      text: JSON.stringify({
        architecture_summary: "Touches the API layer and a new UI component.",
        subtasks: [
          {
            id: "db",
            description: "Add a column to the schema",
            dependencies: [],
            complexity: "moderate",
            risk: 0.3,
            files: ["src/lib/db/migrations/999_x.sql"],
            acceptance_criteria: ["Migration applies cleanly"],
            tests: ["run migration test"],
          },
          {
            id: "api",
            description: "Add an endpoint",
            dependencies: ["db"],
            complexity: "moderate",
            risk: 0.3,
            files: [],
            acceptance_criteria: [],
            tests: [],
          },
        ],
      }),
    });

    const classification = classifyTask("Add a feature with a new endpoint and schema column.");
    const plan = await planTask({
      task: "Add a feature with a new endpoint and schema column.",
      classification,
      repositorySummary: "Next.js + SQLite app.",
      policy: DEFAULT_ROUTING_POLICY,
      callModel,
    });

    assert.equal(plan.plannedBy, DEFAULT_ROUTING_POLICY.leadModel);
    assert.equal(plan.subtasks.length, 2);
    assert.equal(plan.subtasks[1].dependencies[0], "db");
    assert.ok(plan.subtasks[0].recommendedModel.length > 0);
  });

  it("falls back gracefully when the lead model returns unparsable text", async () => {
    const callModel: ModelCaller = async () => ({ text: "not json at all" });
    const classification = classifyTask("Do something.");
    const plan = await planTask({
      task: "Do something.",
      classification,
      repositorySummary: "",
      policy: DEFAULT_ROUTING_POLICY,
      callModel,
    });
    assert.equal(plan.plannedBy, "rule-based-fallback");
  });

  it("falls back gracefully when the lead model call throws", async () => {
    const callModel: ModelCaller = async () => {
      throw new Error("upstream timeout");
    };
    const classification = classifyTask("Do something.");
    const plan = await planTask({
      task: "Do something.",
      classification,
      repositorySummary: "",
      policy: DEFAULT_ROUTING_POLICY,
      callModel,
    });
    assert.equal(plan.plannedBy, "rule-based-fallback");
  });

  it("strips a markdown fence around the JSON before parsing", async () => {
    const callModel: ModelCaller = async () => ({
      text: '```json\n{"architecture_summary":"x","subtasks":[{"id":"a","description":"d"}]}\n```',
    });
    const classification = classifyTask("Do something.");
    const plan = await planTask({
      task: "Do something.",
      classification,
      repositorySummary: "",
      policy: DEFAULT_ROUTING_POLICY,
      callModel,
    });
    assert.equal(plan.plannedBy, DEFAULT_ROUTING_POLICY.leadModel);
    assert.equal(plan.subtasks[0].id, "a");
  });
});
