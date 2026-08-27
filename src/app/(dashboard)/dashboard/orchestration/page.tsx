import OrchestrationPageClient from "./OrchestrationPageClient";

export const metadata = {
  title: "Orchestration — OmniRoute",
  description: "Hierarchical planner/router: submit a task, watch plan → subtask → review flow.",
};

export default function OrchestrationPage() {
  return <OrchestrationPageClient />;
}
