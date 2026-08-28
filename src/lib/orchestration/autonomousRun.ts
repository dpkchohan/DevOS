/**
 * Autonomous run assembly — the integration seam that turns the pure
 * orchestration domain into a system that actually edits the repository.
 *
 * `runAutonomousOrchestration` is what the management API calls. It builds the
 * concrete side-effect dependencies (sandboxed workspace, change-set-applying
 * coding worker, allowlisted test runner) and hands them to the existing
 * `runOrchestration` engine, then runs a final lead review over the REAL git
 * diff and executes a final verification pass.
 *
 * Nothing here re-implements orchestration logic; it only supplies the seams
 * that `src/domain/orchestration/*` already expects.
 *
 * @module lib/orchestration/autonomousRun
 */

import type { ModelCaller, OrchestrationRunState } from "@/domain/orchestration/types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reviewCompletedSubtasks } from "@/domain/orchestration/review";

import { getRoutingPolicy } from "@/lib/db/orchestrationConfig";
import { updateOrchestrationRun } from "@/lib/db/orchestrationRuns";
import { runOrchestration, type OrchestrationProgressEvent } from "./service";
import { Workspace, type AppliedChange } from "./workspace";
import { createCodingModelCaller } from "./codingWorker";
import { createTestRunner, type CommandKey, type CommandResult } from "./testRunner";
import { gitDiff, gitDiffStat, gitStatus } from "./gitInspect";

/** Verification steps run after each subtask. Typecheck is the default gate. */
const DEFAULT_VERIFY_COMMANDS: CommandKey[] = ["typecheck"];

export interface AutonomousRunArgs {
  task: string;
  repositorySummary?: string;
  /** Raw transport (HTTP → /v1/chat/completions). Wrapped internally. */
  callModel: ModelCaller;
  /** Absolute workspace root. Defaults to the server's cwd (the repo). */
  workspaceRoot?: string;
  /** Override the verification commands. Empty array = fail closed. */
  verifyCommands?: CommandKey[];
  /**
   * When true (default) the applied changes are rolled back if the run does
   * not reach "completed". Keeps a failed autonomous run from leaving the
   * repository in a broken half-edited state.
   */
  rollbackOnFailure?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: OrchestrationProgressEvent) => void;
}

export interface AutonomousRunResult {
  run: OrchestrationRunState;
  /** Every file the workers actually changed, in application order. */
  appliedChanges: Array<{ path: string; action: "create" | "modify"; bytesWritten: number }>;
  /** `git diff --stat` after execution (empty string when git is unavailable). */
  diffStat: string;
  /** Verification command results, in execution order. */
  commandResults: Array<Omit<CommandResult, "stdout" | "stderr">>;
  /** Final lead review over the real diff. */
  finalReview: { approved: boolean; defects: string[] } | null;
  /** Whether applied changes were rolled back because the run failed. */
  rolledBack: boolean;
}

const FINAL_REVIEW_SYSTEM_HINT = [
  "You are performing the FINAL review of an autonomous coding run.",
  "You are given the original task, the plan, the applied file manifest, the real git diff,",
  "and the verification command results. Identify only actionable defects: incorrect logic,",
  "missing requirements, regressions, architectural violations, or security problems.",
  "Do NOT propose rewriting unrelated code.",
].join(" ");

/**
 * Execute a task autonomously against a real workspace.
 *
 * Wiring: raw `callModel` → `createCodingModelCaller` (parse + validate +
 * apply) → `runOrchestration` (classify/plan/route/retry/escalate/review) →
 * final lead review over `git diff` → final verification pass.
 */
export async function runAutonomousOrchestration(
  args: AutonomousRunArgs
): Promise<AutonomousRunResult> {
  const {
    task,
    repositorySummary,
    callModel,
    workspaceRoot = process.cwd(),
    verifyCommands = DEFAULT_VERIFY_COMMANDS,
    rollbackOnFailure = true,
    signal,
    onProgress,
  } = args;

  const workspace = new Workspace({ root: workspaceRoot });
  const policy = getRoutingPolicy();

  // Track everything the workers actually wrote, so we can report it and roll
  // it back if the run ends badly.
  const applied: AppliedChange[] = [];
  const commandResults: CommandResult[] = [];

  const codingCaller = createCodingModelCaller({
    workspace,
    callModel,
    onApplied: (changes) => {
      applied.push(...changes);
    },
  });

  const runTests = createTestRunner({
    cwd: workspace.root,
    commands: verifyCommands,
    signal,
    onCommand: (result) => commandResults.push(result),
    workspace,
  });

  const run = await runOrchestration({
    task,
    repositorySummary,
    callModel: codingCaller,
    runTests,
    signal,
    onProgress,
  });

  const changedPaths = [...new Set(applied.map((a) => a.path))];
  const diffStat = await gitDiffStat(workspace.root, changedPaths);

  // Final lead review over the REAL diff — not just the model transcript.
  let finalReview: { approved: boolean; defects: string[] } | null = null;
  if (applied.length > 0) {
    const diff = await gitDiff(workspace.root, changedPaths);
    const status = await gitStatus(workspace.root, changedPaths);
    const verificationSummary = commandResults
      .map(
        (r) =>
          `${r.command} → exit=${r.exitCode}${r.timedOut ? " (TIMED OUT)" : ""} in ${r.durationMs}ms`
      )
      .join("\n");
    // The subtask-level verification (scoped to files THIS run changed, via
    // createTestRunner's typecheck/test:file scoping) already passed for
    // every subtask reaching this point — a raw exit code above can still be
    // non-zero for PRE-EXISTING, unrelated repository diagnostics that are
    // out of scope for this task. Tell the reviewer that explicitly so it
    // judges the change on its own merits rather than the whole-repo exit
    // code (which is not what gated subtask success).
    const verificationContext =
      "Note: verification commands above run against the whole repository, but each subtask's " +
      "PASS/FAIL decision was already scoped to only the files it changed (see the workspace-" +
      "relative applied file list below); a non-zero exit code can reflect pre-existing, " +
      "unrelated repository diagnostics rather than a defect in this change.";
    // For newly-created files `git diff`/`git status` show nothing useful
    // (untracked, and diff has no baseline to compare against) — give the
    // reviewer the actual current contents directly (read from the applied
    // workspace, not the model transcript) so it can verify exact content
    // instead of guessing from an empty diff.
    const appliedContents = applied
      .map((a) => {
        let contents = "(could not read file)";
        try {
          contents = readFileSync(resolve(workspace.root, a.path), "utf8");
        } catch {
          // best-effort context only; never blocks the review
        }
        return `--- ${a.path} (${a.action}, ${a.bytesWritten}B) ---\n${contents}`;
      })
      .join("\n\n");

    finalReview = await reviewCompletedSubtasks({
      leadModel: policy.leadModel,
      completedSubtasks: run.subtasks.filter((s) => s.status === "passed"),
      callModel: async (callArgs) =>
        callModel({
          ...callArgs,
          // Keep the domain reviewer prompt (so its JSON contract holds) and
          // append the real-world evidence the reviewer needs.
          systemPrompt: `${callArgs.systemPrompt}\n\n${FINAL_REVIEW_SYSTEM_HINT}`,
          userPrompt: [
            `Original task:\n${task}`,
            run.plan ? `Plan:\n${run.plan.architectureSummary}` : "",
            `Applied files:\n${applied
              .map((a) => `- ${a.action} ${a.path} (${a.bytesWritten}B)`)
              .join("\n")}`,
            `Applied file contents (authoritative — read directly from the workspace, use this to ` +
              `verify exact content instead of git diff/status for newly created files):\n${appliedContents || "(none)"}`,
            `git status (scoped to files this run changed):\n${status || "(no changes outside what was applied — nothing unrelated)"}`,
            `git diff:\n${diff || "(unavailable, e.g. untracked new files show no diff — see applied file contents above)"}`,
            `Verification:\n${verificationSummary || "(none run)"}\n${verificationContext}`,

            callArgs.userPrompt,
          ]
            .filter(Boolean)
            .join("\n\n---\n\n"),
        }),
      signal,
    });

    if (finalReview.defects.length > 0) {
      run.reviewNotes = [...(run.reviewNotes ?? []), ...finalReview.defects];
    }
    // A final review that finds defects must not leave the run marked clean.
    if (!finalReview.approved && run.status === "completed") {
      run.status = "failed";
      run.error = [run.error, `final review rejected: ${finalReview.defects.join("; ")}`]
        .filter(Boolean)
        .join("; ");
    }
  }

  // Roll back a failed run so the repository is not left half-edited.
  let rolledBack = false;
  if (rollbackOnFailure && run.status !== "completed" && applied.length > 0) {
    workspace.rollback(applied);
    rolledBack = true;
    run.error = [run.error, "applied changes were rolled back"].filter(Boolean).join("; ");
  }

  run.updatedAt = new Date().toISOString();
  updateOrchestrationRun(run);

  return {
    run,
    appliedChanges: applied.map(({ path, action, bytesWritten }) => ({
      path,
      action,
      bytesWritten,
    })),
    diffStat,
    commandResults: commandResults.map(({ stdout: _s, stderr: _e, ...rest }) => {
      void _s;
      void _e;
      return rest;
    }),
    finalReview,
    rolledBack,
  };
}
