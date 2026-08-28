/**
 * Autonomous execution end-to-end test.
 *
 * Proves the loop that was previously missing:
 *   task → classify → plan → route → worker → REAL FILE WRITE → test → result
 *
 * Uses a fake `ModelCaller` (deterministic, no cost/credentials) but a REAL
 * `Workspace` writing to a real temp directory and a REAL TestRunner-shaped
 * verification function. The assertions check the filesystem, not the model
 * transcript, so this cannot pass unless files actually changed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-e2e-db-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getDbInstance } = await import("../../src/lib/db/core.ts");
getDbInstance();

const { runOrchestration } = await import("../../src/lib/orchestration/service.ts");
const { getOrchestrationRun } = await import("../../src/lib/db/orchestrationRuns.ts");
const { resetRoutingPolicy } = await import("../../src/lib/db/orchestrationConfig.ts");
const { Workspace } = await import("../../src/lib/orchestration/workspace.ts");
const { createCodingModelCaller } = await import("../../src/lib/orchestration/codingWorker.ts");

const PLAN = JSON.stringify({
  architecture_summary: "Add one utility module plus its test.",
  subtasks: [
    {
      id: "impl",
      description: "Create the slugify utility",
      dependencies: [],
      complexity: "simple",
      risk: 0.1,
      files: ["src/slugify.ts"],
      acceptance_criteria: ["exports slugify"],
      tests: [],
    },
  ],
});

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-e2e-ws-"));
  return new Workspace({ root });
}

test("worker output is applied to the real workspace and the run completes", async () => {
  resetRoutingPolicy();
  const ws = makeWorkspace();

  const changeSet = JSON.stringify({
    summary: "add slugify",
    files: [
      {
        path: "src/slugify.ts",
        action: "create",
        contents: "export const slugify = (s: string) => s.trim().toLowerCase();\n",
      },
    ],
  });

  const transport = async ({ systemPrompt }: { systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) return { text: PLAN };
    if (systemPrompt.includes("lead reviewer")) {
      return { text: '{"approved":true,"defects":[]}' };
    }
    return { text: changeSet };
  };

  const callModel = createCodingModelCaller({ workspace: ws, callModel: transport });

  // Real verification: the file the worker claimed to write must exist and compile-ish.
  const runTests = async () => {
    if (!ws.exists("src/slugify.ts")) {
      return { passed: false, summary: "src/slugify.ts was never created" };
    }
    const body = ws.readFile("src/slugify.ts");
    return body.includes("export const slugify")
      ? { passed: true, summary: "slugify present" }
      : { passed: false, summary: "slugify export missing" };
  };

  const result = await runOrchestration({
    task: "Add a slugify utility to the project.",
    callModel,
    runTests,
  });

  // Filesystem is the source of truth.
  assert.equal(ws.exists("src/slugify.ts"), true, "worker must have written the file");
  assert.match(ws.readFile("src/slugify.ts"), /export const slugify/);

  assert.equal(result.status, "completed");
  assert.equal(result.subtasks[0].status, "passed");
  assert.equal(getOrchestrationRun(result.id)?.status, "completed");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a failing verification escalates to a stronger model and never auto-passes", async () => {
  resetRoutingPolicy();
  const ws = makeWorkspace();
  const modelsUsed: string[] = [];

  const transport = async ({ model, systemPrompt }: { model: string; systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) return { text: PLAN };
    if (systemPrompt.includes("lead reviewer")) {
      return { text: '{"approved":false,"defects":["still wrong"]}' };
    }
    modelsUsed.push(model);
    // Always writes something, but never the thing verification demands.
    return {
      text: JSON.stringify({
        summary: "attempt",
        files: [
          {
            path: "src/slugify.ts",
            action: ws.exists("src/slugify.ts") ? "modify" : "create",
            contents: `// attempt by ${model}\n`,
          },
        ],
      }),
    };
  };

  const callModel = createCodingModelCaller({ workspace: ws, callModel: transport });
  const runTests = async () => ({ passed: false, summary: "slugify export missing" });

  const result = await runOrchestration({
    task: "Add a slugify utility to the project.",
    callModel,
    runTests,
  });

  assert.equal(result.status, "failed", "a never-passing subtask must fail the run");
  assert.ok(result.error, "failure must be recorded");

  const attempts = result.subtasks[0].attempts;
  assert.equal(attempts.length, 3, "retry budget must be finite (3)");
  // Ladder: same model twice, then a different (stronger) worker.
  assert.equal(modelsUsed[0], modelsUsed[1]);
  assert.notEqual(modelsUsed[2], modelsUsed[0]);
  // Failure context must be preserved for the next attempt.
  assert.match(attempts[0].errorSummary ?? "", /slugify export missing/);

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("malformed worker output is a failure, not a silent success", async () => {
  resetRoutingPolicy();
  const ws = makeWorkspace();

  const transport = async ({ systemPrompt }: { systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) return { text: PLAN };
    if (systemPrompt.includes("lead reviewer")) return { text: '{"approved":true,"defects":[]}' };
    return { text: "I'll add that file for you shortly!" }; // no change set at all
  };

  const callModel = createCodingModelCaller({ workspace: ws, callModel: transport });
  // Verification would pass trivially — the parse failure must still fail the subtask.
  const runTests = async () => ({ passed: true, summary: "" });

  const result = await runOrchestration({
    task: "Add a slugify utility to the project.",
    callModel,
    runTests,
  });

  assert.equal(result.status, "failed");
  assert.match(
    result.subtasks[0].attempts[0].errorSummary ?? "",
    /no JSON object|not valid JSON/i,
    "parse failure must be surfaced as the attempt error"
  );
  assert.equal(ws.exists("src/slugify.ts"), false, "nothing may be written on malformed output");

  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("path-traversal attempts by a model are rejected and write nothing", async () => {
  resetRoutingPolicy();
  const ws = makeWorkspace();

  const transport = async ({ systemPrompt }: { systemPrompt: string }) => {
    if (systemPrompt.includes("lead software architect")) return { text: PLAN };
    if (systemPrompt.includes("lead reviewer")) return { text: '{"approved":true,"defects":[]}' };
    return {
      text: JSON.stringify({
        summary: "escape attempt",
        files: [{ path: "../../../evil.ts", action: "create", contents: "owned\n" }],
      }),
    };
  };

  const callModel = createCodingModelCaller({ workspace: ws, callModel: transport });
  const runTests = async () => ({ passed: true, summary: "" });

  const result = await runOrchestration({
    task: "Add a slugify utility to the project.",
    callModel,
    runTests,
  });

  assert.equal(result.status, "failed");
  assert.match(result.subtasks[0].attempts[0].errorSummary ?? "", /traversal|escape/i);
  assert.equal(fs.existsSync(path.join(ws.root, "..", "..", "..", "evil.ts")), false);

  fs.rmSync(ws.root, { recursive: true, force: true });
});
