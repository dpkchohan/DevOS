/**
 * TestRunner allowlist tests.
 *
 * Regression coverage for the live-API failure `spawn npx ENOENT` (and the
 * follow-up `spawn EINVAL` when naively trying `npx.cmd` directly): on
 * Windows, `child_process.spawn` cannot execute `.cmd` batch shims like
 * `npx`/`npm` directly even with `shell: false` — they must be invoked via
 * `cmd.exe /c <name>` with fixed, code-literal argv. Every
 * `typecheck`/`lint`/`build` verification command failed at spawn time
 * before ever running until this was fixed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { COMMAND_ALLOWLIST } from "../../src/lib/orchestration/testRunner.ts";
import {
  scopeTypecheckOutputToChangedFiles,
  selectTestFileFromChangedPaths,
  parseAppliedChangePaths,
} from "../../src/lib/orchestration/testRunner.ts";

describe("COMMAND_ALLOWLIST executables", () => {
  it("resolves npx/npm-based commands to a spawnable executable on the current platform", () => {
    if (process.platform === "win32") {
      assert.equal(COMMAND_ALLOWLIST.typecheck.file, "cmd.exe");
      assert.deepEqual(COMMAND_ALLOWLIST.typecheck.argv.slice(0, 4), ["/d", "/s", "/c", "npx"]);
      assert.equal(COMMAND_ALLOWLIST.build.file, "cmd.exe");
      assert.deepEqual(COMMAND_ALLOWLIST.build.argv.slice(0, 4), ["/d", "/s", "/c", "npm"]);
    } else {
      assert.equal(COMMAND_ALLOWLIST.typecheck.file, "npx");
      assert.equal(COMMAND_ALLOWLIST.build.file, "npm");
    }
  });

  it("argv is entirely fixed literals in code and never derived from model output", () => {
    assert.deepEqual(COMMAND_ALLOWLIST.typecheck.argv.slice(-2), ["tsc", "--noEmit"]);
    assert.deepEqual(COMMAND_ALLOWLIST.lint.argv.slice(-2), ["eslint", "--max-warnings=0"]);
    for (const key of Object.keys(COMMAND_ALLOWLIST) as (keyof typeof COMMAND_ALLOWLIST)[]) {
      for (const arg of COMMAND_ALLOWLIST[key].argv) {
        assert.equal(typeof arg, "string");
      }
    }
  });

  it("resolves the typecheck executable without ENOENT/EINVAL (regression for the live spawn failures)", async () => {
    // Spawn the SAME resolved [file, ...argv-prefix] with a trivial, fast
    // flag rather than the real `tsc --noEmit` (slow against this repo) to
    // prove the previously-broken spawn path (bare "npx" -> ENOENT; naive
    // "npx.cmd" -> EINVAL) now succeeds.
    const { file, argv } = COMMAND_ALLOWLIST.typecheck;
    const isWindowsShim = file === "cmd.exe";
    const probeArgs = isWindowsShim ? [...argv.slice(0, 3), "npx", "--version"] : ["--version"];

    const exitInfo = await new Promise<{ code: number | null; spawnError: string | null }>(
      (resolve) => {
        const child = spawn(file, probeArgs, { shell: false, stdio: "ignore" });
        child.on("error", (err) => resolve({ code: null, spawnError: err.message }));
        child.on("close", (code) => resolve({ code, spawnError: null }));
      }
    );
    assert.equal(exitInfo.spawnError, null, `spawn("${file}") must not fail with ENOENT/EINVAL`);
    assert.equal(exitInfo.code, 0, "npx --version must exit 0 once spawn actually succeeds");
  });
});

describe("scopeTypecheckOutputToChangedFiles", () => {
  it("keeps only diagnostics whose file matches a changed path", () => {
    const output = [
      "src/unrelated/old.ts(10,5): error TS2339: bad.",
      "src/feature/new.ts(3,1): error TS2345: also bad.",
      "Found 2 errors.",
    ].join("\n");
    const { scopedFailures, totalDiagnostics } = scopeTypecheckOutputToChangedFiles(output, [
      "src/feature/new.ts",
    ]);
    assert.equal(totalDiagnostics, 2);
    assert.equal(scopedFailures.length, 1);
    assert.match(scopedFailures[0], /new\.ts/);
  });

  it("reports zero scoped failures when the pre-existing repo has errors elsewhere", () => {
    const output = "src/totally/unrelated.ts(1,1): error TS1000: pre-existing.\n";
    const { scopedFailures, totalDiagnostics } = scopeTypecheckOutputToChangedFiles(output, [
      "devos-test.txt",
    ]);
    assert.equal(totalDiagnostics, 1);
    assert.equal(scopedFailures.length, 0);
  });

  it("normalizes backslash paths so Windows tsc output still matches", () => {
    const output = "src\\feature\\new.ts(3,1): error TS2345: bad.\n";
    const { scopedFailures } = scopeTypecheckOutputToChangedFiles(output, ["src/feature/new.ts"]);
    assert.equal(scopedFailures.length, 1);
  });
});

describe("selectTestFileFromChangedPaths", () => {
  it("picks a *.test.ts/*.spec.ts file among changed paths", () => {
    assert.equal(selectTestFileFromChangedPaths(["clamp.ts", "clamp.test.ts"]), "clamp.test.ts");
    assert.equal(selectTestFileFromChangedPaths(["a.spec.tsx", "a.tsx"]), "a.spec.tsx");
  });

  it("returns null when no test-like file was changed (fail-closed trigger)", () => {
    assert.equal(selectTestFileFromChangedPaths(["clamp.ts", "README.md"]), null);
    assert.equal(selectTestFileFromChangedPaths([]), null);
  });
});

describe("parseAppliedChangePaths", () => {
  it("extracts paths from the coding worker's applied-changes manifest", () => {
    const text =
      "Summary: did a thing\nApplied changes:\ncreated clamp.ts (42B)\nmodified clamp.test.ts (100B)";
    assert.deepEqual(parseAppliedChangePaths(text), ["clamp.ts", "clamp.test.ts"]);
  });

  it("returns an empty array for text with no manifest", () => {
    assert.deepEqual(parseAppliedChangePaths("no manifest here"), []);
  });
});
