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
import type { SubtaskSpec, TestRunResult } from "@/domain/orchestration/types";

const MAX_CAPTURED_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Allowlisted verification commands. `argv` is fixed in code — never built from
 * model output. `npx` is used because the repo's tooling is local to it.
 */
export const COMMAND_ALLOWLIST = {
  typecheck: { file: "npx", argv: ["tsc", "--noEmit"], timeoutMs: 600_000 },
  lint: { file: "npx", argv: ["eslint", "--max-warnings=0"], timeoutMs: 300_000 },
  "test:file": { file: "node", argv: ["--import", "tsx/esm", "--test"], timeoutMs: 300_000 },
  build: { file: "npm", argv: ["run", "build"], timeoutMs: 900_000 },
} as const;

export type CommandKey = keyof typeof COMMAND_ALLOWLIST;

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
 */
export function createTestRunner(options: TestRunnerOptions) {
  const { cwd, commands = [], signal, onCommand } = options;

  return async function runTests(subtask: SubtaskSpec, _artifact: string): Promise<TestRunResult> {
    void _artifact; // verification runs against the applied workspace, not the raw text

    if (commands.length === 0) {
      return {
        passed: false,
        summary:
          `No verification command was configured for subtask "${subtask.id}", so the change ` +
          "could not be validated. Refusing to report success for unverified work.",
      };
    }

    const failures: string[] = [];
    for (const key of commands) {
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
