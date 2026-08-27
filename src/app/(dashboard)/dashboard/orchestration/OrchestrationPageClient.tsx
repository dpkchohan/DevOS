"use client";

/**
 * Orchestration dashboard panel (Phase 11/15/16): submit a coding task to
 * the hierarchical planner/router, watch plan → subtask → review progress,
 * and inspect prior runs. Talks to /api/v1/management/orchestration.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Card, DataTable, EmptyState } from "@/shared/components";

interface SubtaskAttemptView {
  attempt: number;
  model: string;
  outcome?: "pass" | "fail";
  errorSummary?: string;
}

interface SubtaskView {
  spec: { id: string; description: string; complexity: string; recommendedModel: string };
  status: string;
  attempts: SubtaskAttemptView[];
  result?: string;
}

interface RunView {
  id: string;
  task: string;
  status: string;
  leadModel: string;
  plan?: { architectureSummary: string; plannedBy: string };
  subtasks: SubtaskView[];
  reviewNotes?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function statusVariant(status: string): "success" | "error" | "warning" | "info" | "default" {
  if (status === "completed" || status === "passed") return "success";
  if (status === "failed") return "error";
  if (status === "escalated" || status === "reviewing") return "warning";
  if (status === "executing" || status === "planning" || status === "in_progress") return "info";
  return "default";
}

export default function OrchestrationPageClient() {
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [selected, setSelected] = useState<RunView | null>(null);
  const [error, setError] = useState("");

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/management/orchestration");
      if (res.ok) {
        const data = (await res.json()) as { items: RunView[] };
        setRuns(data.items);
      }
    } catch {
      // best-effort refresh; keep last known list
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const runTask = async () => {
    if (!task.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/v1/management/orchestration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const data = (await res.json()) as RunView | { error: { message: string } };
      if (!res.ok) {
        setError((data as { error: { message: string } }).error?.message ?? `HTTP ${res.status}`);
      } else {
        setSelected(data as RunView);
        setTask("");
        await loadRuns();
      }
    } catch {
      setError("Failed to run orchestration");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card title="Run a task">
        <div className="space-y-3">
          <textarea
            className="w-full rounded border border-border bg-transparent p-2 text-sm"
            rows={4}
            placeholder="Describe the coding task. Claude Opus 5 will plan it, then subtasks route to MiniMax 2.5 / GPT-5.6 Luna / Claude Sonnet 5 based on complexity."
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
          <button
            type="button"
            className="rounded bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={submitting || !task.trim()}
            onClick={() => void runTask()}
          >
            {submitting ? "Running…" : "Run orchestration"}
          </button>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </Card>

      {selected && (
        <Card title={`Run ${selected.id}`}>
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant={statusVariant(selected.status)} dot>
                {selected.status}
              </Badge>
              <Badge variant="info">Lead: {selected.leadModel}</Badge>
            </div>
            {selected.plan && (
              <div>
                <div className="font-medium">Plan ({selected.plan.plannedBy})</div>
                <p className="text-xs text-text-muted">{selected.plan.architectureSummary}</p>
              </div>
            )}
            <div>
              <div className="font-medium">Subtasks</div>
              <ul className="space-y-1">
                {selected.subtasks.map((s) => (
                  <li key={s.spec.id} className="flex items-center gap-2 text-xs">
                    <Badge variant={statusVariant(s.status)} dot>
                      {s.status}
                    </Badge>
                    <span>{s.spec.description}</span>
                    <span className="text-text-muted">
                      ({s.attempts[s.attempts.length - 1]?.model ?? s.spec.recommendedModel})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {selected.reviewNotes && selected.reviewNotes.length > 0 && (
              <div>
                <div className="font-medium">Lead review notes</div>
                <ul className="list-disc pl-4 text-xs">
                  {selected.reviewNotes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            {selected.error && <Badge variant="error">{selected.error}</Badge>}
          </div>
        </Card>
      )}

      <Card title="Recent runs">
        <DataTable
          columns={[
            { key: "id", label: "Run" },
            { key: "status", label: "Status" },
            { key: "leadModel", label: "Lead" },
            { key: "task", label: "Task", maxWidth: "28rem" },
          ]}
          data={runs.map((r) => ({ ...r, id: r.id }))}
          emptyMessage="No orchestration runs yet"
          loading={false}
          onRowClick={(row) => {
            const run = runs.find((r) => r.id === String(row.id));
            if (run) setSelected(run);
          }}
          renderCell={(row, column) => {
            const run = row as unknown as RunView;
            if (column.key === "status")
              return (
                <Badge variant={statusVariant(run.status)} dot>
                  {run.status}
                </Badge>
              );
            if (column.key === "id") return <code className="text-xs">{run.id}</code>;
            return (run as unknown as Record<string, unknown>)[column.key]?.toString() ?? "—";
          }}
        />
        {runs.length === 0 && (
          <EmptyState title="No runs yet" description="Submit a task above to start." />
        )}
      </Card>
    </div>
  );
}
