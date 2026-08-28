/**
 * Workspace sandbox + change-set protocol tests.
 *
 * These cover the security boundary (path traversal, absolute paths, protected
 * locations, extension policy) and the strict failure semantics that keep an
 * unverified or malformed model response from becoming a "pass".
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Workspace, WorkspaceViolationError } from "../../src/lib/orchestration/workspace.ts";
import { parseChangeSet, ChangeSetParseError } from "../../src/lib/orchestration/changeSet.ts";

let root: string;
let ws: Workspace;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ws-"));
  fs.writeFileSync(path.join(root, "existing.ts"), "export const a = 1;\n", "utf8");
  ws = new Workspace({ root });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Workspace path security", () => {
  it("rejects absolute paths", () => {
    assert.throws(() => ws.resolveInWorkspace("C:\\Windows\\x.ts"), WorkspaceViolationError);
    assert.throws(() => ws.resolveInWorkspace("/etc/passwd.ts"), WorkspaceViolationError);
  });

  it("rejects parent-directory traversal", () => {
    assert.throws(() => ws.resolveInWorkspace("../outside.ts"), WorkspaceViolationError);
    assert.throws(() => ws.resolveInWorkspace("a/../../outside.ts"), WorkspaceViolationError);
  });

  it("rejects protected locations", () => {
    assert.throws(() => ws.resolveInWorkspace(".git/config"), WorkspaceViolationError);
    assert.throws(() => ws.resolveInWorkspace("node_modules/x/index.js"), WorkspaceViolationError);
    assert.throws(() => ws.resolveInWorkspace("a/.ssh/id_rsa"), WorkspaceViolationError);
  });

  it("rejects null bytes and empty paths", () => {
    assert.throws(() => ws.resolveInWorkspace("a\0b.ts"), WorkspaceViolationError);
    assert.throws(() => ws.resolveInWorkspace("   "), WorkspaceViolationError);
  });

  it("accepts a normal nested relative path inside the root", () => {
    assert.ok(ws.resolveInWorkspace("src/util/helper.ts").startsWith(ws.root));
  });
});

describe("Workspace change-set validation", () => {
  it("rejects an empty change set", () => {
    assert.throws(() => ws.validateChangeSet([]), WorkspaceViolationError);
  });

  it("rejects disallowed file extensions", () => {
    assert.throws(
      () => ws.validateChangeSet([{ path: "evil.exe", action: "create", contents: "x" }]),
      WorkspaceViolationError
    );
  });

  it("rejects create on an existing file and modify on a missing file", () => {
    assert.throws(
      () => ws.validateChangeSet([{ path: "existing.ts", action: "create", contents: "x" }]),
      WorkspaceViolationError
    );
    assert.throws(
      () => ws.validateChangeSet([{ path: "nope.ts", action: "modify", contents: "x" }]),
      WorkspaceViolationError
    );
  });

  it("rejects duplicate paths in one change set", () => {
    assert.throws(
      () =>
        ws.validateChangeSet([
          { path: "dup.ts", action: "create", contents: "a" },
          { path: "dup.ts", action: "create", contents: "b" },
        ]),
      WorkspaceViolationError
    );
  });
});

describe("Workspace apply + rollback", () => {
  it("applies a change set and can roll it back exactly", () => {
    const original = ws.readFile("existing.ts");
    const applied = ws.applyChangeSet([
      { path: "new-file.ts", action: "create", contents: "export const b = 2;\n" },
      { path: "existing.ts", action: "modify", contents: "export const a = 99;\n" },
    ]);

    assert.equal(applied.length, 2);
    assert.equal(ws.readFile("existing.ts"), "export const a = 99;\n");
    assert.ok(ws.exists("new-file.ts"));

    ws.rollback(applied);
    assert.equal(ws.readFile("existing.ts"), original);
    assert.equal(ws.exists("new-file.ts"), false);
  });

  it("writes nothing when any entry in the set is invalid", () => {
    const original = ws.readFile("existing.ts");
    assert.throws(
      () =>
        ws.applyChangeSet([
          { path: "existing.ts", action: "modify", contents: "changed\n" },
          { path: "../escape.ts", action: "create", contents: "bad\n" },
        ]),
      WorkspaceViolationError
    );
    // Validation precedes all writes, so the file must be untouched.
    assert.equal(ws.readFile("existing.ts"), original);
  });
});

describe("parseChangeSet", () => {
  it("parses a well-formed change set", () => {
    const parsed = parseChangeSet(
      JSON.stringify({
        summary: "add a helper",
        files: [{ path: "src/x.ts", action: "create", contents: "export const x = 1;" }],
      })
    );
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].action, "create");
  });

  it("tolerates markdown fences and surrounding chatter", () => {
    const parsed = parseChangeSet(
      'Sure!\n```json\n{"summary":"s","files":[{"path":"a.ts","action":"create","contents":"x"}]}\n```\nDone.'
    );
    assert.equal(parsed.files[0].path, "a.ts");
  });

  it("throws on empty or prose-only output rather than reporting success", () => {
    assert.throws(() => parseChangeSet(""), ChangeSetParseError);
    assert.throws(() => parseChangeSet("I cannot do that."), ChangeSetParseError);
  });

  it("throws on an empty files array", () => {
    assert.throws(() => parseChangeSet('{"files":[]}'), ChangeSetParseError);
  });

  it("throws when the model self-reports an error", () => {
    assert.throws(() => parseChangeSet('{"error":"insufficient context"}'), ChangeSetParseError);
  });

  it("throws on a malformed file entry", () => {
    assert.throws(
      () => parseChangeSet('{"files":[{"path":"a.ts","action":"delete","contents":"x"}]}'),
      ChangeSetParseError
    );
    assert.throws(
      () => parseChangeSet('{"files":[{"path":"a.ts","action":"create"}]}'),
      ChangeSetParseError
    );
  });
});
