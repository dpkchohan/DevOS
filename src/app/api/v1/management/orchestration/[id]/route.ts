/**
 * GET /api/v1/management/orchestration/[id] — inspect a single
 * orchestration run's plan/subtask status/model choices/failures/result
 * (Phase 16).
 */
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse, createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { getRun } from "@/lib/orchestration/service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const run = getRun(id);
    if (!run) {
      return createErrorResponse({ status: 404, message: "Orchestration run not found" });
    }
    return Response.json(run);
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to load orchestration run");
  }
}
