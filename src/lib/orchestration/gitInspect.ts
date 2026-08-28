/**
 * Git inspection — read-only helpers so the orchestration layer (and the lead
 * reviewer) can see what actually changed on disk.
 *
 * Read-only by design: status/diff/diff --stat only. No commit, no checkout,
 * no reset, no clean. Orchestration must never be able to destroy work or
 * rewrite history through this seam.
 *
 * @module lib/orchestration/gitInspect
 */

import { spawn } from "node:child_process";

const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_CHARS = 24_000;

/** Read-only git subcommands orchestration may run. Fixed argv, no shell. */
const READ_ONLY_GIT_ARGS = {
  status: ["status", "--porcelain"],
  diff: ["--no-pager", "diff"],
  diffStat: ["--no-pager", "diff", "--stat"],
  diffCached: ["--no-pager", "diff", "--cached"],
} as const;

export type GitReadCommand = keyof typeof READ_ONLY_GIT_ARGS;

function runGit(command: GitReadCommand, cwd: string, extraArgs: string[] = []): Promise<string> {
  const argv = [...READ_ONLY_GIT_ARGS[command], ...extraArgs];
  return new Promise((resolve) => {
    const child = spawn("git", argv, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => {
      if (out.length < MAX_DIFF_CHARS * 2) out += c.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(
        out.length > MAX_DIFF_CHARS ? `${out.slice(0, MAX_DIFF_CHARS)}\n…[diff truncated]` : out
      );
    });
  });
}

export function gitStatus(cwd: string): Promise<string> {
  return runGit("status", cwd);
}

/** Unified diff of unstaged changes, optionally scoped to specific paths. */
export function gitDiff(cwd: string, paths: string[] = []): Promise<string> {
  return runGit("diff", cwd, paths.length > 0 ? ["--", ...paths] : []);
}

export function gitDiffStat(cwd: string, paths: string[] = []): Promise<string> {
  return runGit("diffStat", cwd, paths.length > 0 ? ["--", ...paths] : []);
}
