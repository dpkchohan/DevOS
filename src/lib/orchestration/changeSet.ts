/**
 * Change-set protocol — parses and validates the structured output a worker
 * model must return in order for its work to be applied.
 *
 * Models never get to hand us prose that we execute. They must emit a JSON
 * object with an explicit file list. Anything unparsable, wrongly shaped, or
 * empty is a HARD FAILURE that becomes failure context for the next attempt —
 * it is never silently treated as success.
 *
 * @module lib/orchestration/changeSet
 */

import type { FileChange } from "./workspace";

export const CHANGE_SET_PROTOCOL_PROMPT = [
  "You must respond with ONLY a JSON object describing the file changes to make.",
  "No prose, no explanation outside the JSON, no markdown fences.",
  "Shape:",
  '{"summary":"<one line>","files":[{"path":"relative/path.ts","action":"create"|"modify","contents":"<FULL new file contents>"}]}',
  "Rules:",
  "- `path` MUST be relative to the repository root. Never absolute, never containing '..'.",
  "- `contents` MUST be the COMPLETE final file contents, not a diff or a fragment.",
  "- Use action 'create' only for files that do not exist yet, 'modify' for existing files.",
  "- Do not touch .git, node_modules, .env, or any credential/secret file.",
  '- If you cannot complete the subtask, return {"error":"<reason>"} instead of guessing.',
  "- If this subtask requires a test file, name it with a `.test.ts`/`.spec.ts` (or .tsx/.js/.jsx) " +
    "suffix so the verification step can identify and run exactly that file.",
].join("\n");

export class ChangeSetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeSetParseError";
  }
}

export interface ParsedChangeSet {
  summary: string;
  files: FileChange[];
}

/** Strip an accidental ```json fence some models emit despite instructions. */
function unfence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Extract the outermost JSON object from a response that may have leading or
 * trailing chatter. Returns null when no balanced object is found.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse a worker model's response into a validated change set.
 *
 * Throws `ChangeSetParseError` on anything malformed. Callers MUST treat a
 * throw as a subtask failure (feeding the message back as failure context),
 * never as a pass.
 */
export function parseChangeSet(raw: string): ParsedChangeSet {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ChangeSetParseError("Model returned an empty response");
  }

  const candidate = extractJsonObject(unfence(raw));
  if (!candidate) {
    throw new ChangeSetParseError(
      "Model response contained no JSON object. Respond with ONLY the required JSON change-set object."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new ChangeSetParseError(
      `Model response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChangeSetParseError("Model response JSON must be an object");
  }

  const obj = parsed as Record<string, unknown>;

  // An explicit self-reported failure is a failure, not an empty success.
  if (typeof obj.error === "string" && obj.error.trim() !== "") {
    throw new ChangeSetParseError(`Model reported it could not complete the subtask: ${obj.error}`);
  }

  if (!Array.isArray(obj.files)) {
    throw new ChangeSetParseError('Model response is missing the required "files" array');
  }
  if (obj.files.length === 0) {
    throw new ChangeSetParseError(
      'Model returned an empty "files" array — no changes were produced'
    );
  }

  const files: FileChange[] = obj.files.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ChangeSetParseError(`files[${index}] is not an object`);
    }
    const e = entry as Record<string, unknown>;

    if (typeof e.path !== "string" || e.path.trim() === "") {
      throw new ChangeSetParseError(`files[${index}].path must be a non-empty string`);
    }
    if (e.action !== "create" && e.action !== "modify") {
      throw new ChangeSetParseError(
        `files[${index}].action must be "create" or "modify" (got ${JSON.stringify(e.action)})`
      );
    }
    if (typeof e.contents !== "string") {
      throw new ChangeSetParseError(
        `files[${index}].contents must be a string containing the full file contents`
      );
    }
    return { path: e.path.trim(), action: e.action, contents: e.contents };
  });

  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    files,
  };
}
