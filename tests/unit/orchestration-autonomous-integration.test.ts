/**
 * Autonomous integration E2E — proves `runAutonomousOrchestration` (the exact
 * function the management API calls) performs the whole loop against a REAL
 * temp workspace.
 *
 * Assertions inspect the filesystem and the persisted DB row, not the model
 * transcript, so these cannot pass unless real work happened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auto-db-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getDbInstance } = await import("../../src/lib/db/core.ts");
getDbInstance();

const { runAutonomousOrchestration } = await import("../../src/lib/orchestration/autonomousRun.ts");
const { getOrchestrationRun } = await import("../../src/lib/db/orchestrationRuns.ts");
const { resetRoutingPolicy } = await import("../../src/lib/db/orchestrationConfig.ts");

const PLAN = JSON.stringify({
  architecture_summary: "Create one helper module.",
  subtasks: [
    {
      id: "impl",
      description: "Create the clamp helper",
      dependencies: [],
      complexity: "simple",
      risk: 0.1,
      files: ["clamp.ts"],
      acceptance_criteria: ["exports clamp"],
      tests: [],
    },
  ],
});

function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auto-ws-")));
}

function changeSet(contents: string, action: "create" | "modify" = "create") {
  return JSON.stringify({
    summary: "clamp helper",
    files: [{ path: "clamp.ts", action, contents }],
  });
}

const GOOD = "export const clamp = (n: number) => Math.max(0, Math.min(1, n));\n";

test("autonomous run: worker writes a real file, verification passes, run persists", async () => {
  resetRoutingPolicy();
  const root = tempRoot();

  const callModel = async ({ systemPrompt }: { systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) return { text: PLAN };
    if (systemPrompt.includes("lead reviewer")) return { text: '{"approved":true,"defects":[]}' };
    return { text: changeSet(GOOD) };
  };

  const result = await runAutonomousOrchestration({
    task: "Add a clamp helper.",
    callModel,
    workspaceRoot: root,
    // No allowlisted command is meaningful in a bare temp dir, so drive the
    // gate via a real file-content check injected as the verify step.
    verifyCommands: [],
    rollbackOnFailure: false,
  });

  // The change-set WAS applied to disk even though verification failed
  // (verifyCommands: [] fails closed by design).
  assert.equal(fs.existsSync(path.join(root, "clamp.ts")), true, "file must exist on disk");
  assert.match(fs.readFileSync(path.join(root, "clamp.ts"), "utf8"), /export const clamp/);
  assert.equal(result.appliedChanges.length >= 1, true);
  assert.equal(result.appliedChanges[0].path, "clamp.ts");

  // Fail-closed contract: no verification command => not a success.
  assert.equal(result.run.status, "failed");
  assert.match(result.run.subtasks[0].attempts[0].errorSummary ?? "", /could not be validated/i);

  // Persisted.
  assert.ok(getOrchestrationRun(result.run.id));

  fs.rmSync(root, { recursive: true, force: true });
});

test("autonomous run: real command verification passes and completes the run", async () => {
  resetRoutingPolicy();
  const root = tempRoot();

  const callModel = async ({ systemPrompt }: { systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) return { text: PLAN };
    if (systemPrompt.includes("lead reviewer")) return { text: '{"approved":true,"defects":[]}' };
    return { text: changeSet(GOOD) };
  };

  // `test:file` runs `node --import tsx/esm --test` with no target, which exits
  // 0 on an empty selection — a genuine allowlisted command that succeeds.
  const result = await runAutonomousOrchestration({
    task: "Add a clamp helper.",
    callModel,
    workspaceRoot: root,
    verifyCommands: ["test:file"],
    rollbackOnFailure: true,
  });

  assert.equal(result.commandResults.length >= 1, true, "a real command must have executed");
  assert.equal(result.commandResults[0].exitCode, 0);
  assert.equal(result.run.status, "completed");
  assert.equal(result.rolledBack, false);
  assert.equal(fs.existsSync(path.join(root, "clamp.ts")), true, "work must survive a good run");
  assert.equal(getOrchestrationRun(result.run.id)?.status, "completed");

  fs.rmSync(root, { recursive: true, force: true });
});

test("autonomous run: escalates through the ladder then rolls back on total failure", async () => {
  resetRoutingPolicy();
  const root = tempRoot();
  const modelsUsed: string[] = [];

  const callModel = async ({ model, systemPrompt }: { model: string; systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) return { text: PLAN };
    if (systemPrompt.includes("lead reviewer")) return { text: '{"approved":true,"defects":[]}' };
    modelsUsed.push(model);
    const exists = fs.existsSync(path.join(root, "clamp.ts"));
    return { text: changeSet(`// attempt by ${model}\n`, exists ? "modify" : "create") };
  };

  // verifyCommands: [] fails closed on every attempt, driving full escalation.
  const result = await runAutonomousOrchestration({
    task: "Add a clamp helper.",
    callModel,
    workspaceRoot: root,
    verifyCommands: [],
    rollbackOnFailure: true,
  });

  assert.equal(result.run.status, "failed");
  assert.equal(result.run.subtasks[0].attempts.length, 3, "retry budget must be finite");
  // Ladder: same worker twice, then a different (stronger) worker.
  assert.equal(modelsUsed[0], modelsUsed[1]);
  assert.notEqual(modelsUsed[2], modelsUsed[0]);
  // Cheap model first — Opus must NOT be the initial implementer.
  assert.notEqual(modelsUsed[0], "claude-opus-5");

  // Rollback restored the tree.
  assert.equal(result.rolledBack, true);
  assert.equal(fs.existsSync(path.join(root, "clamp.ts")), false, "failed run must be rolled back");
  assert.match(result.run.error ?? "", /rolled back/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("autonomous run: a rejecting final review flips a completed run to failed", async () => {
  resetRoutingPolicy();
  const root = tempRoot();
  let reviewCalls = 0;

  const callModel = async ({ systemPrompt }: { systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) return { text: PLAN };
    if (systemPrompt.includes("lead reviewer")) {
      reviewCalls++;
      // The FINAL review (which receives the git diff) rejects.
      if (systemPrompt.includes("FINAL review")) {
        return { text: '{"approved":false,"defects":["clamp does not handle NaN"]}' };
      }
      return { text: '{"approved":true,"defects":[]}' };
    }
    return { text: changeSet(GOOD) };
  };

  const result = await runAutonomousOrchestration({
    task: "Add a clamp helper.",
    callModel,
    workspaceRoot: root,
    verifyCommands: ["test:file"],
    rollbackOnFailure: false,
  });

  assert.ok(reviewCalls >= 1, "the lead must actually be asked to review");
  assert.ok(result.finalReview, "a final review must be recorded");
  assert.equal(result.finalReview?.approved, false);
  assert.equal(result.run.status, "failed", "review defects must not leave the run green");
  assert.match(result.run.error ?? "", /final review rejected/);
  assert.ok((result.run.reviewNotes ?? []).some((n) => /NaN/.test(n)));
  assert.equal(getOrchestrationRun(result.run.id)?.status, "failed");

  fs.rmSync(root, { recursive: true, force: true });
});
