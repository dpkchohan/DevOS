# DEvOS — Autonomous Developer Agent

DEvOS is an autonomous coding-agent layer built **on top of
[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** (MIT). OmniRoute
supplies multi-provider LLM routing, auth, quotas, and the dashboard; DEvOS adds
a hierarchical planner/worker system that **actually edits a repository,
verifies the result, and rolls back on failure**.

> **Relationship to OmniRoute:** DEvOS is additive. Everything under
> `src/domain/orchestration/` and `src/lib/orchestration/` is new; the rest of
> the tree is upstream OmniRoute and is deliberately left alone. Upstream
> copyright and the MIT LICENSE are retained.

## What it does

```
USER TASK
   ↓
POST /api/v1/management/orchestration
   ↓
classifyTask            complexity tier + risk/architecture signals
   ↓
Opus 5 LEAD PLANNER     structured JSON plan → subtasks + dependencies
   ↓
MODEL ROUTER            cheapest model that is good enough
   ↓
CODING WORKER           returns a structured change set (never prose)
   ↓
SAFE WORKSPACE          validated, sandboxed writes
   ↓
REAL FILES CHANGED
   ↓
TEST RUNNER             allowlisted commands, real exit codes
   ↓
git diff
   ↓
Opus 5 REVIEW           reviews the real diff, not the transcript
   ↓
PASS / RETRY / ESCALATE / ROLLBACK
   ↓
persisted run + JSON result
```

## Model hierarchy

| Role                                           | Model              | When                                               |
| ---------------------------------------------- | ------------------ | -------------------------------------------------- |
| Lead / planner / reviewer / escalation ceiling | `claude-opus-5`    | Planning, periodic + final review, last retry rung |
| Strong worker                                  | `claude-sonnet-5`  | COMPLEX / CRITICAL subtasks, hard debugging        |
| Fast worker                                    | `minimax-m2.5`     | TRIVIAL / SIMPLE / MODERATE (default first pick)   |
| Fast worker                                    | `gpt-5.6-luna`     | Same tiers; also a strong-worker alternate         |
| Lightweight fallback                           | `claude-haiku-4-5` | Small/simple work, fallback                        |

**Opus leads; it does not implement everything.** `selectInitialModel` sends
trivial/simple/moderate work to `fastWorkers` and complex/critical work to
`strongWorkers`. Opus is reached only via planning, review, or the escalation
ladder. This is enforced by test, not just convention.

Routing is configurable at runtime via `setRoutingPolicy()`
(`src/lib/db/orchestrationConfig.ts`, `key_value` namespace `orchestration`).

## Autonomous execution

`runAutonomousOrchestration()` (`src/lib/orchestration/autonomousRun.ts`) is the
integration seam the API calls. It builds the concrete side-effect dependencies
and hands them to the pure engine:

- `Workspace` — the only module that touches the filesystem
- `createCodingModelCaller` — parse → validate → apply the change set
- `createTestRunner` — allowlisted verification commands
- `gitInspect` — read-only `status` / `diff` / `diff --stat`

Everything in `src/domain/orchestration/` stays pure (no DB, no network), which
is why it is fully unit-testable with fakes.

### Change-set protocol

Workers must return JSON — arbitrary prose is never executed:

```json
{
  "summary": "add clamp helper",
  "files": [{ "path": "src/clamp.ts", "action": "create", "contents": "<FULL file contents>" }]
}
```

Rejected (each becomes failure context for the next attempt, never a pass):
unparsable JSON, missing/empty `files`, bad `action`, non-string `contents`,
`{"error": "..."}` self-reported failure, unsafe paths.

## Security model

| Control               | Implementation                                                 |
| --------------------- | -------------------------------------------------------------- |
| Workspace confinement | `resolveInWorkspace()` is the single choke point               |
| Absolute paths        | rejected (incl. `C:\` drive-letter form)                       |
| `..` traversal        | rejected after normalisation                                   |
| Symlink escape        | deepest existing ancestor is `realpath`-checked                |
| Protected paths       | `.git`, `node_modules`, `.env`, `.ssh`, `.aws`, `.npmrc`       |
| Write types           | extension allowlist (no binaries/executables)                  |
| Size / count caps     | 512 KB per file, 25 files per change set                       |
| Atomicity             | validate-all-then-write; partial failure auto-rolls-back       |
| Run rollback          | failed runs restore the tree (`rollbackOnFailure`, default on) |
| Command execution     | fixed-argv allowlist only, `shell: false`                      |
| Timeouts              | per-command, child `SIGKILL` on expiry                         |
| Git writes            | none — inspection is read-only                                 |
| Unverified work       | **fails closed** — never reported as success                   |
| Credentials           | never written into run rows                                    |

The caller's Bearer key is reused for internal model calls, so orchestration
cannot escape that key's model allow-list or quotas.

## API

```bash
curl -X POST http://localhost:20128/api/v1/management/orchestration \
  -H "Authorization: Bearer <omniroute-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"task":"Add a clamp utility with tests.","verifyCommands":["typecheck"]}'
```

| Field               | Meaning                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `task`              | required, 1–20 000 chars                                                                             |
| `repositorySummary` | optional context for the planner                                                                     |
| `verifyCommands`    | subset of `typecheck` \| `lint` \| `test:file` \| `build`. **Omitting/empty ⇒ unverified ⇒ failure** |
| `rollbackOnFailure` | default `true`                                                                                       |
| `dryRun`            | plan only, no file edits                                                                             |

Response: `{ mode, run, appliedChanges, diffStat, commandResults, finalReview, rolledBack }`.

- `GET /api/v1/management/orchestration` — recent runs
- `GET /api/v1/management/orchestration/:id` — one run

An API key is **required** (a dashboard session alone is not sufficient).

## Testing

```bash
node --import tsx/esm --test tests/unit/orchestration-*.test.ts
```

The E2E suites use fake `ModelCaller`s but a **real** temp `Workspace`, **real**
spawned commands, and a **real** SQLite DB, and assert against the filesystem
and DB rows — so they cannot pass unless work actually happened.

## Limitations

- Subtasks execute sequentially; independent-subtask parallelism is not implemented.
- The dashboard lists runs but does not yet render `appliedChanges` / `diffStat` / `commandResults`.
- Real-provider execution requires a configured OmniRoute API key and provider connection.
- `npm run build` may exhaust the V8 heap on constrained machines; use
  `NODE_OPTIONS=--max-old-space-size=8192`.

## Development setup

```bash
npm install
npm run dev            # http://localhost:20128
```

Migration `164_orchestration_runs.sql` applies automatically on start.
See `docs/architecture/orchestration.md` for module-level detail.

## License

MIT. Built on OmniRoute — Copyright (c) 2026 diegosouzapw. See `LICENSE`.
