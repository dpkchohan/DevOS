/**
 * Coding worker (`createCodingModelCaller`) tests.
 *
 * Regression coverage for the live-API failure mode where a subtask retry
 * re-invokes the worker with no memory of a prior attempt's successful
 * write, causing the worker to (correctly, from its own point of view)
 * request `action: "create"` again on a path a previous attempt already
 * created — which `Workspace` rejects as "already exists". The fix
 * normalizes a repeat `create` on an already-created path to `modify`
 * WITHOUT weakening any Workspace security check.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Workspace, WorkspaceViolationError } from "../../src/lib/orchestration/workspace.ts";
import { createCodingModelCaller } from "../../src/lib/orchestration/codingWorker.ts";
import type { ModelCaller } from "../../src/domain/orchestration/types.ts";

let root: string;
let ws: Workspace;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codingworker-")));
  ws = new Workspace({ root });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function changeSetText(action: "create" | "modify", contents: string) {
  return JSON.stringify({
    summary: "write devos-test.txt",
    files: [{ path: "devos-test.txt", action, contents }],
  });
}

describe("createCodingModelCaller — retry normalization", () => {
  it("normalizes a repeat 'create' on an already-created path to 'modify' instead of throwing", async () => {
    let call = 0;
    const rawCallModel: ModelCaller = async () => {
      call += 1;
      // The worker always asks for "create" — it has no memory of the
      // previous attempt, exactly like the live bug report.
      return { text: changeSetText("create", `attempt ${call}\n`) };
    };

    const codingCaller = createCodingModelCaller({ workspace: ws, callModel: rawCallModel });

    // Attempt 1 succeeds normally.
    await codingCaller({ model: "m", systemPrompt: "s", userPrompt: "u" });
    assert.equal(fs.readFileSync(path.join(root, "devos-test.txt"), "utf8"), "attempt 1\n");

    // Attempt 2 (a retry of the SAME subtask) must NOT throw even though the
    // worker again requested "create" on a path that now exists.
    await assert.doesNotReject(async () => {
      await codingCaller({ model: "m", systemPrompt: "s", userPrompt: "u" });
    });
    assert.equal(fs.readFileSync(path.join(root, "devos-test.txt"), "utf8"), "attempt 2\n");
  });

  it("still rejects 'create' on a path that pre-existed BEFORE this caller ever ran", async () => {
    fs.writeFileSync(path.join(root, "pre-existing.ts"), "export const a = 1;\n", "utf8");
    const rawCallModel: ModelCaller = async () => ({
      text: JSON.stringify({
        summary: "x",
        files: [{ path: "pre-existing.ts", action: "create", contents: "export const b = 2;\n" }],
      }),
    });
    const codingCaller = createCodingModelCaller({ workspace: ws, callModel: rawCallModel });

    await assert.rejects(
      () => codingCaller({ model: "m", systemPrompt: "s", userPrompt: "u" }),
      WorkspaceViolationError
    );
  });

  it("still enforces every Workspace security check on every attempt (path traversal)", async () => {
    const rawCallModel: ModelCaller = async () => ({
      text: JSON.stringify({
        summary: "x",
        files: [{ path: "../outside.ts", action: "create", contents: "x" }],
      }),
    });
    const codingCaller = createCodingModelCaller({ workspace: ws, callModel: rawCallModel });

    await assert.rejects(
      () => codingCaller({ model: "m", systemPrompt: "s", userPrompt: "u" }),
      WorkspaceViolationError
    );
  });
});
