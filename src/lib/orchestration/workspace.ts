/**
 * Workspace sandbox — the ONLY module permitted to touch the filesystem on
 * behalf of an orchestration worker.
 *
 * Every path a model produces is untrusted input. `resolveInWorkspace` is the
 * single choke point: it rejects absolute paths, `..` traversal, symlink
 * escapes, and any resolved path outside the configured workspace root. All
 * read/write helpers go through it, so there is no way to reach outside the
 * root without editing this file.
 *
 * Deliberately NOT a general shell/FS bridge: no delete-tree, no rename, no
 * chmod, no arbitrary command execution. See `testRunner.ts` for the separate
 * allowlisted command layer.
 *
 * @module lib/orchestration/workspace
 */

import fs from "node:fs";
import path from "node:path";

/** Path segments an orchestration worker may never create or modify. */
const DENIED_PATH_SEGMENTS = [".git", "node_modules", ".env", ".ssh", ".aws", ".npmrc"];

/** Extensions a worker may write. Keeps models out of binaries/secrets. */
const ALLOWED_WRITE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".sql",
  ".css",
  ".yml",
  ".yaml",
  ".txt",
]);

const DEFAULT_MAX_FILE_BYTES = 512_000;
const DEFAULT_MAX_FILES = 25;

export class WorkspaceViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceViolationError";
  }
}

export interface WorkspaceOptions {
  /** Absolute path to the workspace root. Nothing outside it is reachable. */
  root: string;
  maxFileBytes?: number;
  maxFilesPerChangeSet?: number;
}

export interface FileChange {
  path: string;
  /** "create" must not overwrite; "modify" must target an existing file. */
  action: "create" | "modify";
  contents: string;
}

export interface AppliedChange {
  path: string;
  action: "create" | "modify";
  bytesWritten: number;
  /** Previous contents, retained so the change set can be rolled back. */
  previousContents: string | null;
}

export class Workspace {
  readonly root: string;
  private readonly maxFileBytes: number;
  private readonly maxFilesPerChangeSet: number;

  constructor(options: WorkspaceOptions) {
    if (!path.isAbsolute(options.root)) {
      throw new WorkspaceViolationError(`Workspace root must be absolute: ${options.root}`);
    }
    // realpathSync collapses symlinks up front so later realpath comparisons
    // cannot be defeated by a symlinked root.
    this.root = fs.realpathSync(options.root);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFilesPerChangeSet = options.maxFilesPerChangeSet ?? DEFAULT_MAX_FILES;
  }

  /**
   * Resolve a model-supplied relative path to an absolute path inside the
   * workspace, or throw. THIS IS THE SECURITY BOUNDARY.
   */
  resolveInWorkspace(relativePath: string): string {
    if (typeof relativePath !== "string" || relativePath.trim() === "") {
      throw new WorkspaceViolationError("Path must be a non-empty string");
    }
    if (relativePath.includes("\0")) {
      throw new WorkspaceViolationError("Path contains a null byte");
    }
    if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
      throw new WorkspaceViolationError(`Absolute paths are not allowed: ${relativePath}`);
    }

    const normalized = path.normalize(relativePath).replace(/\\/g, "/");
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new WorkspaceViolationError(`Path traversal is not allowed: ${relativePath}`);
    }

    const lowerSegments = normalized.toLowerCase().split("/");
    for (const denied of DENIED_PATH_SEGMENTS) {
      if (lowerSegments.includes(denied)) {
        throw new WorkspaceViolationError(`Path targets a protected location: ${relativePath}`);
      }
    }

    const absolute = path.resolve(this.root, normalized);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (absolute !== this.root && !absolute.startsWith(rootWithSep)) {
      throw new WorkspaceViolationError(`Path escapes the workspace root: ${relativePath}`);
    }

    // Reject symlink escapes: realpath the deepest existing ancestor and
    // re-check containment.
    let probe = absolute;
    while (probe !== this.root && !fs.existsSync(probe)) {
      probe = path.dirname(probe);
    }
    if (fs.existsSync(probe)) {
      const realProbe = fs.realpathSync(probe);
      if (realProbe !== this.root && !realProbe.startsWith(rootWithSep)) {
        throw new WorkspaceViolationError(`Path resolves outside the workspace: ${relativePath}`);
      }
    }

    return absolute;
  }

  exists(relativePath: string): boolean {
    return fs.existsSync(this.resolveInWorkspace(relativePath));
  }

  readFile(relativePath: string): string {
    return fs.readFileSync(this.resolveInWorkspace(relativePath), "utf8");
  }

  /** Validate a change set without writing anything. Throws on violation. */
  validateChangeSet(changes: FileChange[]): void {
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new WorkspaceViolationError("Change set must contain at least one file change");
    }
    if (changes.length > this.maxFilesPerChangeSet) {
      throw new WorkspaceViolationError(
        `Change set touches ${changes.length} files, exceeding the limit of ${this.maxFilesPerChangeSet}`
      );
    }

    const seen = new Set<string>();
    for (const change of changes) {
      const absolute = this.resolveInWorkspace(change.path);

      if (seen.has(absolute)) {
        throw new WorkspaceViolationError(`Duplicate path in change set: ${change.path}`);
      }
      seen.add(absolute);

      if (change.action !== "create" && change.action !== "modify") {
        throw new WorkspaceViolationError(
          `Unsupported action "${String(change.action)}" for ${change.path}`
        );
      }
      if (typeof change.contents !== "string") {
        throw new WorkspaceViolationError(`Contents must be a string for ${change.path}`);
      }

      const bytes = Buffer.byteLength(change.contents, "utf8");
      if (bytes > this.maxFileBytes) {
        throw new WorkspaceViolationError(
          `${change.path} is ${bytes} bytes, exceeding the ${this.maxFileBytes} byte limit`
        );
      }

      const ext = path.extname(absolute).toLowerCase();
      if (!ALLOWED_WRITE_EXTENSIONS.has(ext)) {
        throw new WorkspaceViolationError(
          `Writing "${ext || "(no extension)"}" files is not allowed: ${change.path}`
        );
      }

      const fileExists = fs.existsSync(absolute);
      if (change.action === "create" && fileExists) {
        throw new WorkspaceViolationError(
          `${change.path} already exists — use action "modify" to change it`
        );
      }
      if (change.action === "modify" && !fileExists) {
        throw new WorkspaceViolationError(
          `${change.path} does not exist — use action "create" to add it`
        );
      }
    }
  }

  /**
   * Validate everything first, then write. Returns per-file records including
   * previous contents so a later stage (tests/review) can roll the set back.
   */
  applyChangeSet(changes: FileChange[]): AppliedChange[] {
    this.validateChangeSet(changes);

    const applied: AppliedChange[] = [];
    try {
      for (const change of changes) {
        const absolute = this.resolveInWorkspace(change.path);
        const previousContents =
          change.action === "modify" ? fs.readFileSync(absolute, "utf8") : null;

        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, change.contents, "utf8");

        applied.push({
          path: change.path,
          action: change.action,
          bytesWritten: Buffer.byteLength(change.contents, "utf8"),
          previousContents,
        });
      }
    } catch (err) {
      // Partial failure — undo what was already written so the tree is never
      // left half-modified.
      this.rollback(applied);
      throw err;
    }
    return applied;
  }

  /** Restore files to their pre-apply state. Best effort, never throws. */
  rollback(applied: AppliedChange[]): void {
    for (const record of [...applied].reverse()) {
      try {
        const absolute = this.resolveInWorkspace(record.path);
        if (record.previousContents === null) {
          if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
        } else {
          fs.writeFileSync(absolute, record.previousContents, "utf8");
        }
      } catch {
        // Swallow: rollback is a recovery path, not a correctness guarantee.
      }
    }
  }
}
