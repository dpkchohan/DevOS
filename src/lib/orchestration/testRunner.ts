/**
 * Command runner + real TestRunner — the ONLY module permitted to spawn a
 * process on behalf of orchestration.
 *
 * Safety model:
 *   - Commands are chosen from a fixed ALLOWLIST by key. Model output never
 *     becomes a command string; a model can at most influence WHICH allowlisted
 *     key runs, never the argv.
 *   - `shell: false` always, so there is no shell metacharacter surface.
 *   - Every command has a hard timeout and the child is killed on expiry.
 *   - Output is captured and truncated; exit code is authoritative.
 *
 * Critically: `createTestRunner` NEVER returns `{ passed: true }` by default.
 * If no command can be run, that is a FAILURE, because an unverified change is
 * not a verified change.
 *
 * @module lib/orchestration/testRunner
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { SubtaskSpec, TestRunResult } from "@/domain/orchestration/types";
import type { Workspace } from "./workspace";

const MAX_CAPTURED_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Resolve a spawnable [file, prefixArgs] pair for npm-shipped CLI shims on
 * the current platform. On Windows, `npx`/`npm` are `.cmd` batch shims that
 * `child_process.spawn` cannot execute directly even with `shell: false`
 * (Node throws `EINVAL`/`ENOENT` either way) — Windows requires such shims
 * to be invoked through `cmd.exe /c`. This does NOT reintroduce a shell
 * metacharacter surface: every argv element passed to `cmd.exe /c` here is
 * a fixed literal baked into `COMMAND_ALLOWLIST`, never derived from model
 * output, exactly like every other entry in this allowlist.
 */
function shimInvocation(name: "npx" | "npm"): { file: string; prefixArgs: string[] } {
  return process.platform === "win32"
    ? { file: "cmd.exe", prefixArgs: ["/d", "/s", "/c", name] }
    : { file: name, prefixArgs: [] };
}

/**
 * Allowlisted verification commands. `argv` is fixed in code — never built from
 * model output. `npx` is used because the repo's tooling is local to it.
 */
export const COMMAND_ALLOWLIST = {
  typecheck: {
    file: shimInvocation("npx").file,
    argv: [...shimInvocation("npx").prefixArgs, "tsc", "--noEmit"],
    timeoutMs: 600_000,
  },
  lint: {
    file: shimInvocation("npx").file,
    argv: [...shimInvocation("npx").prefixArgs, "eslint", "--max-warnings=0"],
    timeoutMs: 300_000,
  },
  "test:file": { file: "node", argv: ["--import", "tsx/esm", "--test"], timeoutMs: 300_000 },
  build: {
    file: shimInvocation("npm").file,
    argv: [...shimInvocation("npm").prefixArgs, "run", "build"],
    timeoutMs: 900_000,
  },
} as const;

export type CommandKey = keyof typeof COMMAND_ALLOWLIST;

/** Matches common test/spec file naming conventions a worker might create. */
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i;

/** Extracts the leading file path from a tsc/eslint diagnostic line, e.g. "src/x.ts(12,3): error TS...". */
function diagnosticFilePath(line: string): string | null {
  const match = line.match(/^([^\r\n]+?)\((\d+),(\d+)\):\s*(error|warning)\b/);
  return match ? match[1] : null;
}

function normalizePathForCompare(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/^\.\//, "");
  // Windows filesystem paths are case-insensitive; comparing case-sensitively
  // there would silently fail to scope real matches.
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Filter a `tsc --noEmit` diagnostic stream down to only the lines that
 * reference one of `changedPaths` (workspace-relative paths this subtask
 * attempt actually wrote). This is what lets a subtask's typecheck gate
 * judge ONLY the files it touched, instead of requiring the entire
 * pre-existing repository to be error-free before any change can verify.
 */
export function scopeTypecheckOutputToChangedFiles(
  output: string,
  changedPaths: string[]
): { scopedFailures: string[]; totalDiagnostics: number } {
  const changedSet = new Set(changedPaths.map(normalizePathForCompare));
  const scopedFailures: string[] = [];
  let totalDiagnostics = 0;
  for (const line of output.split(/\r?\n/)) {
    const filePath = diagnosticFilePath(line);
    if (!filePath) continue;
    totalDiagnostics += 1;
    if (changedSet.has(normalizePathForCompare(filePath))) {
      scopedFailures.push(line);
    }
  }
  return { scopedFailures, totalDiagnostics };
}

/**
 * Picks the single most plausible test file from a subtask's applied
 * changes, by naming convention (`*.test.ts`, `*.spec.tsx`, etc.). Returns
 * null when no such file was among the changes, so the caller can fail
 * closed rather than fall back to an unscoped repository-wide run.
 */
export function selectTestFileFromChangedPaths(changedPaths: string[]): string | null {
  return changedPaths.find((p) => TEST_FILE_PATTERN.test(p)) ?? null;
}

export interface CommandResult {
  key: CommandKey;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function truncate(text: string): string {
  return text.length > MAX_CAPTURED_CHARS
    ? `${text.slice(0, MAX_CAPTURED_CHARS)}\n…[truncated]`
    : text;
}

/**
 * Run one allowlisted command. `extraArgs` are appended (used for file paths);
 * they are passed as separate argv entries, never interpolated into a shell.
 */
export function runAllowlistedCommand(
  key: CommandKey,
  cwd: string,
  extraArgs: string[] = [],
  signal?: AbortSignal
): Promise<CommandResult> {
  const spec = COMMAND_ALLOWLIST[key];
  if (!spec) {
    return Promise.reject(new Error(`Command "${String(key)}" is not allowlisted`));
  }

  const argv = [...spec.argv, ...extraArgs];
  const started = Date.now();

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(spec.file, argv, {
      cwd,
      shell: false,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort);

    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length < MAX_CAPTURED_CHARS * 2) stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < MAX_CAPTURED_CHARS * 2) stderr += c.toString();
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        key,
        command: `${spec.file} ${argv.join(" ")}`,
        exitCode,
        timedOut,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        durationMs: Date.now() - started,
      });
    };

    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Parses the "Applied changes:\n created/modified <path> (<n>B)" manifest that
 * `createCodingModelCaller` emits as its returned text, so verification can be
 * scoped to exactly the files THIS attempt changed without any change to the
 * pure domain `TestRunner` signature. */
export function parseAppliedChangePaths(artifactText: string): string[] {
  const paths: string[] = [];
  const lineRe = /^(?:created|modified)\s+(.+?)\s+\(\d+B\)$/;
  for (const line of artifactText.split(/\r?\n/)) {
    const match = line.trim().match(lineRe);
    if (match) paths.push(match[1]);
  }
  return paths;
}

export interface TestRunnerOptions {
  /** Absolute workspace root; commands run with this as cwd. */
  cwd: string;
  /**
   * Verification steps to run, in order. Empty means "nothing can be verified",
   * which the runner reports as a FAILURE rather than a pass.
   */
  commands?: CommandKey[];
  signal?: AbortSignal;
  /** Called with each command result for progress/telemetry. */
  onCommand?: (result: CommandResult) => void;
  /**
   * Required for the "test:file" command: resolves the worker-identified test
   * file path through the same security boundary every other write goes
   * through, before it is ever passed to spawn().
   */
  workspace?: Workspace;
}

function summarizeFailure(result: CommandResult): string {
  const reason = result.timedOut
    ? `timed out after ${result.durationMs}ms`
    : `exited with code ${result.exitCode}`;
  // stderr first: for tsc/eslint/node --test the actionable detail is there or
  // at the tail of stdout.
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n").trim();
  return `Command \`${result.command}\` ${reason}.\n${detail || "(no output captured)"}`;
}

/**
 * Build a production `TestRunner` that actually executes verification commands.
 *
 * Contract (deliberately strict):
 *   - No commands configured        → { passed: false }  ("unverified" != "ok")
 *   - Any command non-zero/timeout  → { passed: false } + structured detail
 *   - All commands exit 0           → { passed: true }
 *
 * Scoping (this subtask's attempt only, never the whole pre-existing repo):
 *   - `typecheck` runs the (unavoidably whole-program) `tsc --noEmit`, but the
 *     PASS/FAIL decision only looks at diagnostics whose file path matches one
 *     of the files THIS attempt actually created/modified (parsed from the
 *     worker's own applied-changes manifest). Pre-existing errors elsewhere in
 *     this large repository can no longer block an unrelated change from
 *     verifying, while a real compile error IN a changed file still fails.
 *   - `test:file` REQUIRES an explicit test file path (derived from this
 *     attempt's changed files by `*.test.*`/`*.spec.*` naming convention) and
 *     runs `node --test <that one file>` — never an unscoped, repo-wide
 *     `node --test` that would discover thousands of unrelated files. The path
 *     is still resolved through `Workspace.resolveInWorkspace` before use, so
 *     the existing path-traversal / protected-location boundary still applies.
 *   - No test file can be identified and `test:file` was requested → FAIL
 *     closed with a clear reason, never silently skipped.
 */
export function createTestRunner(options: TestRunnerOptions) {
  const { cwd, commands = [], signal, onCommand, workspace } = options;

  return async function runTests(
    subtask: SubtaskSpec,
    artifactText: string
  ): Promise<TestRunResult> {
    if (commands.length === 0) {
      return {
        passed: false,
        summary:
          `No verification command was configured for subtask "${subtask.id}", so the change ` +
          "could not be validated. Refusing to report success for unverified work.",
      };
    }

    const changedPaths = parseAppliedChangePaths(artifactText);

    const failures: string[] = [];
    for (const key of commands) {
      if (key === "typecheck") {
        const result = await runAllowlistedCommand("typecheck", cwd, [], signal);
        onCommand?.(result);
        if (result.timedOut) {
          failures.push(summarizeFailure(result));
          break;
        }
        // tsc exits non-zero whenever ANY diagnostic exists anywhere in the
        // program, including pre-existing errors unrelated to this change —
        // so the exit code alone cannot gate a single subtask. Scope the
        // PASS/FAIL decision to diagnostics that land in a file this attempt
        // actually touched.
        const combinedOutput = `${result.stdout}\n${result.stderr}`;
        const { scopedFailures, totalDiagnostics } = scopeTypecheckOutputToChangedFiles(
          combinedOutput,
          changedPaths
        );
        if (scopedFailures.length > 0) {
          failures.push(
            `Command \`${result.command}\` reported ${scopedFailures.length} error(s) in file(s) ` +
              `this subtask changed (of ${totalDiagnostics} total diagnostic(s) in the repository):\n` +
              scopedFailures.join("\n")
          );
          break;
        }
        // Zero-diagnostic exit is still success even if tsc's own exit code
        // is non-zero for unrelated pre-existing repo errors — those are out
        // of scope for this subtask.
        continue;
      }

      if (key === "test:file") {
        const testFilePath = selectTestFileFromChangedPaths(changedPaths);
        if (!testFilePath) {
          failures.push(
            'Verification "test:file" requires an explicit test file, but this attempt did not ' +
              "create/modify any file matching *.test.*/*.spec.* — refusing to fall back to an " +
              "unscoped, repository-wide `node --test` run."
          );
          break;
        }
        if (!workspace) {
          failures.push(
            'Verification "test:file" requires a Workspace to resolve the test file path safely, ' +
              "but none was configured."
          );
          break;
        }
        // Re-validates the path through the SAME security boundary every
        // other file write goes through (path traversal / protected
        // locations / absolute paths) before it is ever passed to spawn().
        let resolvedAbsolutePath: string;
        try {
          resolvedAbsolutePath = workspace.resolveInWorkspace(testFilePath);
        } catch (err) {
          failures.push(
            `Verification "test:file" refused an unsafe test file path "${testFilePath}": ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
          break;
        }
        const relativeForSpawn = path.relative(cwd, resolvedAbsolutePath);
        const result = await runAllowlistedCommand("test:file", cwd, [relativeForSpawn], signal);
        onCommand?.(result);
        if (result.timedOut || result.exitCode !== 0) {
          failures.push(summarizeFailure(result));
          break;
        }
        continue;
      }

      const result = await runAllowlistedCommand(key, cwd, [], signal);
      onCommand?.(result);
      if (result.timedOut || result.exitCode !== 0) {
        failures.push(summarizeFailure(result));
        // Stop at the first failure: later stages are usually noise once an
        // earlier gate fails, and the worker needs one clear signal.
        break;
      }
    }

    if (failures.length > 0) {
      return { passed: false, summary: failures.join("\n\n") };
    }
    return {
      passed: true,
      summary: `All verification commands passed: ${commands.join(", ")}`,
    };
  };
}
