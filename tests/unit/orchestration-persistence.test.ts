/**
 * Orchestration persistence + service integration tests — Phases 13/14/19.
 *
 * Uses an isolated DATA_DIR (own SQLite file) so the migration and CRUD
 * paths are exercised against a real on-disk DB, matching the existing
 * convention (see tests/unit/7993-noauth-proxy-routing.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-orchestration-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getDbInstance } = await import("../../src/lib/db/core.ts");
getDbInstance();

const {
  createOrchestrationRun,
  deleteOrchestrationRun,
  getOrchestrationRun,
  listOrchestrationRuns,
  listResumableOrchestrationRuns,
  updateOrchestrationRun,
} = await import("../../src/lib/db/orchestrationRuns.ts");
const { getRoutingPolicy, setRoutingPolicy, resetRoutingPolicy } =
  await import("../../src/lib/db/orchestrationConfig.ts");
const { runOrchestration } = await import("../../src/lib/orchestration/service.ts");
const { DEFAULT_ROUTING_POLICY } = await import("../../src/domain/orchestration/router.ts");

function makeRun(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    task: "Do a thing",
    status: "planning" as
      "planning" | "executing" | "reviewing" | "completed" | "failed" | "canceled",
    subtasks: [] as never[],
    createdAt: now,
    updatedAt: now,
    leadModel: "claude-opus-5",
  };
}

test("createOrchestrationRun + getOrchestrationRun round-trips a run", () => {
  const run = makeRun("run-1");
  createOrchestrationRun(run);
  const fetched = getOrchestrationRun("run-1");
  assert.ok(fetched);
  assert.equal(fetched?.task, "Do a thing");
  assert.equal(fetched?.status, "planning");
});

test("updateOrchestrationRun persists status/plan/subtask changes", () => {
  const run = makeRun("run-2");
  createOrchestrationRun(run);
  run.status = "completed";
  updateOrchestrationRun(run);
  const fetched = getOrchestrationRun("run-2");
  assert.equal(fetched?.status, "completed");
});

test("listResumableOrchestrationRuns only returns non-terminal runs", () => {
  createOrchestrationRun(makeRun("run-3-executing"));
  const terminalRun = makeRun("run-3-completed");
  terminalRun.status = "completed";
  createOrchestrationRun(terminalRun);

  const resumable = listResumableOrchestrationRuns();
  const ids = resumable.map((r) => r.id);
  assert.ok(ids.includes("run-3-executing"));
  assert.ok(!ids.includes("run-3-completed"));
});

test("listOrchestrationRuns respects the limit and orders by updated_at desc", () => {
  createOrchestrationRun(makeRun("run-4a"));
  createOrchestrationRun(makeRun("run-4b"));
  const runs = listOrchestrationRuns(1);
  assert.equal(runs.length, 1);
});

test("deleteOrchestrationRun removes the row", () => {
  createOrchestrationRun(makeRun("run-5"));
  assert.equal(deleteOrchestrationRun("run-5"), true);
  assert.equal(getOrchestrationRun("run-5"), null);
});

test("getRoutingPolicy defaults, setRoutingPolicy overrides, resetRoutingPolicy clears", () => {
  resetRoutingPolicy();
  assert.deepEqual(getRoutingPolicy(), DEFAULT_ROUTING_POLICY);

  setRoutingPolicy({ leadModel: "claude-opus-5-custom" });
  const updated = getRoutingPolicy();
  assert.equal(updated.leadModel, "claude-opus-5-custom");
  // Unset fields still come from defaults.
  assert.deepEqual(updated.fastWorkers, DEFAULT_ROUTING_POLICY.fastWorkers);

  resetRoutingPolicy();
  assert.deepEqual(getRoutingPolicy(), DEFAULT_ROUTING_POLICY);
});

test("runOrchestration end-to-end with a fake ModelCaller/TestRunner completes and persists", async () => {
  resetRoutingPolicy();
  const planJson = JSON.stringify({
    architecture_summary: "Small change to one file.",
    subtasks: [
      {
        id: "only",
        description: "Implement the requested change",
        dependencies: [],
        complexity: "simple",
        risk: 0.1,
        files: [],
        acceptance_criteria: ["it works"],
        tests: [],
      },
    ],
  });

  let planCalls = 0;
  const callModel = async ({ systemPrompt }: { systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) {
      planCalls++;
      return { text: planJson };
    }
    return { text: "implementation output" };
  };
  const runTests = async () => ({ passed: true, summary: "" });

  const events: string[] = [];
  const result = await runOrchestration({
    task: "Implement a small feature.",
    callModel,
    runTests,
    onProgress: (e) => events.push(e.type),
  });

  assert.equal(planCalls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.subtasks.length, 1);
  assert.equal(result.subtasks[0].status, "passed");
  assert.ok(events.includes("classified"));
  assert.ok(events.includes("planned"));
  assert.ok(events.includes("subtask_started"));
  assert.ok(events.includes("subtask_finished"));
  assert.ok(events.includes("completed"));

  const persisted = getOrchestrationRun(result.id);
  assert.ok(persisted);
  assert.equal(persisted?.status, "completed");
});

test("runOrchestration records failure state when a subtask never passes", async () => {
  resetRoutingPolicy();
  const planJson = JSON.stringify({
    architecture_summary: "x",
    subtasks: [
      {
        id: "broken",
        description: "This will keep failing",
        dependencies: [],
        complexity: "simple",
        risk: 0.1,
        files: [],
        acceptance_criteria: [],
        tests: [],
      },
    ],
  });
  const callModel = async ({ systemPrompt }: { systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) return { text: planJson };
    return { text: "attempt" };
  };
  const runTests = async () => ({ passed: false, summary: "always fails" });

  const result = await runOrchestration({
    task: "Do the impossible.",
    callModel,
    runTests,
  });

  assert.equal(result.status, "failed");
  assert.ok(result.error);
});
