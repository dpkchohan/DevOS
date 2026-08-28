/**
 * Coding worker — the seam that turns "model returned text" into "files on
 * disk changed, or a clean failure".
 *
 * This is the piece that was missing: `createCodingModelCaller` wraps a plain
 * `ModelCaller` so that each worker attempt must produce a valid change set,
 * which is validated and applied to the sandboxed workspace. The returned
 * `text` is a human-readable summary of what was actually applied, which is
 * what the lead reviewer later reads alongside the git diff.
 *
 * Failure semantics (non-negotiable):
 *   - unparsable/empty/self-reported-error output → THROW
 *   - path or policy violation                    → THROW
 *   - partially applied set                       → rolled back, then THROW
 * A throw is caught by `runSubtask`, recorded as a failed attempt, and its
 * message becomes the failure context for the next attempt. Nothing is ever
 * silently upgraded to success.
 *
 * @module lib/orchestration/codingWorker
 */

import type { ModelCaller } from "@/domain/orchestration/types";
import { CHANGE_SET_PROTOCOL_PROMPT, parseChangeSet } from "./changeSet";
import { Workspace, type AppliedChange } from "./workspace";

export interface CodingModelCallerOptions {
  /** Sandbox the worker writes through. */
  workspace: Workspace;
  /** Underlying transport (e.g. the HTTP caller hitting /v1/chat/completions). */
  callModel: ModelCaller;
  /** Records every applied change set so the caller can roll back / report. */
  onApplied?: (changes: AppliedChange[], summary: string) => void;
}

/**
 * Wrap a `ModelCaller` so its output is treated as a change set and applied.
 *
 * The change-set protocol is appended to whatever system prompt the executor
 * supplies, so the domain layer keeps owning the task framing while this layer
 * owns the output contract.
 */
export function createCodingModelCaller(options: CodingModelCallerOptions): ModelCaller {
  const { workspace, callModel, onApplied } = options;

  return async ({ model, systemPrompt, userPrompt, signal }) => {
    const result = await callModel({
      model,
      systemPrompt: `${systemPrompt}\n\n${CHANGE_SET_PROTOCOL_PROMPT}`,
      userPrompt,
      signal,
    });

    // Throws ChangeSetParseError on malformed output — becomes failure context.
    const changeSet = parseChangeSet(result.text);

    // Throws WorkspaceViolationError on unsafe paths / policy breaches, and
    // rolls back internally if a write fails midway.
    const applied = workspace.applyChangeSet(changeSet.files);
    onApplied?.(applied, changeSet.summary);

    const manifest = applied
      .map(
        (a) => `${a.action === "create" ? "created" : "modified"} ${a.path} (${a.bytesWritten}B)`
      )
      .join("\n");

    return {
      text: [changeSet.summary ? `Summary: ${changeSet.summary}` : "", "Applied changes:", manifest]
        .filter(Boolean)
        .join("\n"),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    };
  };
}
