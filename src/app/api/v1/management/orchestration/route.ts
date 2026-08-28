/**
 * POST /api/v1/management/orchestration — run a new hierarchical
 * planner/router orchestration (Phase 16: API surface for orchestration).
 * GET  /api/v1/management/orchestration — list recent runs.
 *
 * Auth follows the existing management convention (`requireManagementAuth`).
 * The caller's own API key (extracted from the SAME request) is reused as
 * the credential for every model call the orchestration makes internally,
 * via `createHttpModelCaller` dispatching back through this server's own
 * `/v1/chat/completions` — so orchestration never bypasses per-key model
 * allow-lists/scopes/quotas (Phase 12 security requirement).
 */
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse, createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { extractApiKey } from "@/sse/services/auth";
import { runOrchestration, listRuns } from "@/lib/orchestration/service";
import { runAutonomousOrchestration } from "@/lib/orchestration/autonomousRun";
import { createHttpModelCaller } from "@/lib/orchestration/modelCaller";

const runRequestSchema = z.object({
  task: z.string().min(1).max(20_000),
  repositorySummary: z.string().max(20_000).optional(),
  /**
   * Verification gate(s) run after each subtask. Fixed allowlist keys only —
   * never raw command strings, so this can never become shell injection.
   */
  verifyCommands: z.array(z.enum(["typecheck", "lint", "test:file", "build"])).optional(),
  /** Set false to keep partial edits on failure (default: roll back). */
  rollbackOnFailure: z.boolean().optional(),
  /**
   * Plan-only mode: classify + plan and persist, WITHOUT editing the
   * repository. Explicit opt-in so the default is the real autonomous path.
   */
  dryRun: z.boolean().optional(),
});

function resolveSelfBaseUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 50)));
    return Response.json({ items: listRuns(limit) });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to list orchestration runs");
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }

  const parsed = runRequestSchema.safeParse(bodyJson);
  if (!parsed.success) {
    return createErrorResponse({
      status: 400,
      message: "Invalid orchestration request",
      details: parsed.error.flatten(),
    });
  }

  // The dashboard session path has no bearer API key to reuse for internal
  // model calls; orchestration model calls require one (the loopback caller
  // dispatches through the public /v1/chat/completions surface with it).
  const apiKey = extractApiKey(request, { allowUrl: false });
  if (!apiKey) {
    return createErrorResponse({
      status: 400,
      message:
        "Orchestration requires an API key (Authorization: Bearer <key>) so internal model calls respect the caller's model access — dashboard-session auth alone cannot run orchestration.",
    });
  }

  const callModel = createHttpModelCaller({
    baseUrl: resolveSelfBaseUrl(request),
    apiKey,
  });

  try {
    // dryRun keeps the old plan-only behaviour available for inspection; the
    // DEFAULT is the real autonomous path that edits the repository.
    if (parsed.data.dryRun) {
      const planOnly = await runOrchestration({
        task: parsed.data.task,
        repositorySummary: parsed.data.repositorySummary,
        callModel,
        // No runTests: the executor fails closed, so a dry run reports
        // "unverified" rather than a false success.
      });
      return Response.json({ mode: "dry-run", run: planOnly });
    }

    const result = await runAutonomousOrchestration({
      task: parsed.data.task,
      repositorySummary: parsed.data.repositorySummary,
      callModel,
      verifyCommands: parsed.data.verifyCommands,
      rollbackOnFailure: parsed.data.rollbackOnFailure,
    });

    return Response.json({
      mode: "autonomous",
      run: result.run,
      appliedChanges: result.appliedChanges,
      diffStat: result.diffStat,
      commandResults: result.commandResults,
      finalReview: result.finalReview,
      rolledBack: result.rolledBack,
    });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Orchestration run failed");
  }
}
