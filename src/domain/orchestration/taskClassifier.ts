/**
 * Task Complexity Classifier — Orchestration Phase 3.
 *
 * Given a coding request (free text), estimates complexity and produces the
 * signals the router and planner need. Pure/deterministic — no I/O — so it
 * is trivially unit-testable and safe to call on every incoming task.
 *
 * Reuses the multilingual keyword-matching approach already established by
 * `open-sse/services/intentClassifier.ts` rather than inventing a new
 * technique; this module answers a different question though (complexity
 * tier + task attributes for orchestration, not model-fitness intent).
 *
 * Configurable via `classifyTask(text, config)` — callers may extend the
 * keyword lists without editing this file (Phase 3 requirement).
 *
 * @module domain/orchestration/taskClassifier
 */

import type { TaskClassification, TaskComplexity } from "./types";

export interface TaskClassifierConfig {
  criticalKeywords?: string[];
  complexKeywords?: string[];
  moderateKeywords?: string[];
  trivialKeywords?: string[];
  /** Word count below which a task defaults toward TRIVIAL/SIMPLE. */
  trivialMaxWords?: number;
  simpleMaxWords?: number;
}

const CRITICAL_KEYWORDS = [
  "auth",
  "authentication",
  "authorization",
  "credential",
  "secret",
  "password",
  "api key",
  "encryption",
  "encrypt",
  "decrypt",
  "security",
  "vulnerability",
  "drop table",
  "delete from",
  "truncate",
  "migration",
  "migrate database",
  "destructive",
  "production database",
  "rotate keys",
  "access control",
  "permission",
  "privilege",
];

const COMPLEX_KEYWORDS = [
  "architecture",
  "refactor the",
  "redesign",
  "cross-system",
  "integration",
  "distributed",
  "concurrency",
  "race condition",
  "database schema",
  "schema change",
  "migration",
  "debug",
  "root cause",
  "performance issue",
  "memory leak",
  "deadlock",
];

const MODERATE_KEYWORDS = [
  "feature",
  "endpoint",
  "api integration",
  "add support for",
  "implement",
  "multi-file",
  "refactor",
  "new component",
  "new module",
];

const TRIVIAL_KEYWORDS = [
  "typo",
  "rename",
  "formatting",
  "format the",
  "whitespace",
  "comment",
  "one-line",
  "one line",
  "small text",
  "capitalize",
  "lint fix",
];

function countMatches(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase()));
}

/** Rough estimate of files affected — count explicit file-path-looking tokens. */
function estimateFileCount(text: string): number {
  const filePathPattern = /\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|sql|json|md|css|yml|yaml)\b/gi;
  const matches = text.match(filePathPattern) ?? [];
  const unique = new Set(matches.map((m) => m.toLowerCase()));
  if (unique.size > 0) return unique.size;
  // No explicit paths named — heuristic based on scope language.
  if (/\ball\b.*\bfiles\b|\bproject-wide\b|\bentire (codebase|repo)\b/i.test(text)) return 10;
  if (/\bmulti-file\b|\bacross\b.*\bmodules\b/i.test(text)) return 4;
  return 1;
}

function computeComplexity(
  text: string,
  cfg: TaskClassifierConfig
): { complexity: TaskComplexity; signals: string[] } {
  const critical = countMatches(text, [...CRITICAL_KEYWORDS, ...(cfg.criticalKeywords ?? [])]);
  if (critical.length > 0) return { complexity: "critical", signals: critical };

  const complex = countMatches(text, [...COMPLEX_KEYWORDS, ...(cfg.complexKeywords ?? [])]);
  if (complex.length > 0) return { complexity: "complex", signals: complex };

  const moderate = countMatches(text, [...MODERATE_KEYWORDS, ...(cfg.moderateKeywords ?? [])]);
  if (moderate.length > 0) return { complexity: "moderate", signals: moderate };

  const trivial = countMatches(text, [...TRIVIAL_KEYWORDS, ...(cfg.trivialKeywords ?? [])]);
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const trivialMaxWords = cfg.trivialMaxWords ?? 12;
  const simpleMaxWords = cfg.simpleMaxWords ?? 40;

  if (trivial.length > 0 && wordCount <= trivialMaxWords) {
    return { complexity: "trivial", signals: trivial };
  }
  if (wordCount <= simpleMaxWords) {
    return { complexity: "simple", signals: trivial.length > 0 ? trivial : ["short-request"] };
  }
  return { complexity: "moderate", signals: ["default-moderate"] };
}

/**
 * Classify a coding task from its free-text description.
 *
 * Deliberately conservative: any critical-signal keyword wins outright
 * (Phase 12 — security-sensitive changes must not be silently downgraded
 * to a lower complexity tier by dilution from other heuristics).
 */
export function classifyTask(text: string, config: TaskClassifierConfig = {}): TaskClassification {
  const { complexity, signals } = computeComplexity(text, config);
  const estimatedFileCount = estimateFileCount(text);
  const architectureImpact =
    complexity === "complex" || complexity === "critical" || estimatedFileCount >= 5;

  const risk =
    complexity === "critical"
      ? 0.9
      : complexity === "complex"
        ? 0.6
        : complexity === "moderate"
          ? 0.35
          : complexity === "simple"
            ? 0.15
            : 0.05;

  const lower = text.toLowerCase();
  const reasoningRequired =
    complexity === "complex" ||
    complexity === "critical" ||
    /\bwhy\b|\bdebug\b|\banalyz|\bdesign\b|\btrade-?off/i.test(lower);
  const codingRequired = !/^(explain|what is|describe|summarize)\b/i.test(text.trim());
  const testingRequired = complexity !== "trivial";
  const repoExplorationRequired =
    complexity === "moderate" || complexity === "complex" || complexity === "critical";
  const externalResearchRequired =
    /\bdocs\b|\bdocumentation\b|\bapi reference\b|\bresearch\b/i.test(lower);
  const humanConfirmationRequired = complexity === "critical";

  return {
    complexity,
    estimatedFileCount,
    architectureImpact,
    risk,
    reasoningRequired,
    codingRequired,
    testingRequired,
    repoExplorationRequired,
    externalResearchRequired,
    humanConfirmationRequired,
    signals,
  };
}
