/**
 * db/orchestrationConfig.ts — configurable routing policy for the
 * hierarchical planner/router (Phase 15: dashboard-configurable lead/worker
 * models, complexity thresholds, retry limits, fallback models, cost/latency
 * preference, review policy).
 *
 * Follows the established `key_value` table convention (namespace
 * "orchestration", key "policy") used across `db/*.ts` — no new table
 * needed for a single JSON blob of policy config.
 *
 * @module lib/db/orchestrationConfig
 */

import { getDbInstance } from "./core";
import type { RoutingPolicy } from "@/domain/orchestration/types";
import { DEFAULT_ROUTING_POLICY } from "@/domain/orchestration/router";

const NAMESPACE = "orchestration";
const KEY = "policy";

function readKeyValue(): string | null {
  const db = getDbInstance();
  const row = db
    .prepare(`SELECT value FROM key_value WHERE namespace = ? AND key = ? LIMIT 1`)
    .get(NAMESPACE, KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeKeyValue(value: string): void {
  const db = getDbInstance();
  db.prepare(`INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)`).run(
    NAMESPACE,
    KEY,
    value
  );
}

function isRoutingPolicyShape(value: unknown): value is Partial<RoutingPolicy> {
  return !!value && typeof value === "object";
}

/** Read the operator-configured routing policy, merged over the defaults. */
export function getRoutingPolicy(): RoutingPolicy {
  const raw = readKeyValue();
  if (!raw) return DEFAULT_ROUTING_POLICY;
  try {
    const parsed = JSON.parse(raw);
    if (!isRoutingPolicyShape(parsed)) return DEFAULT_ROUTING_POLICY;
    return { ...DEFAULT_ROUTING_POLICY, ...parsed };
  } catch {
    return DEFAULT_ROUTING_POLICY;
  }
}

/** Persist an operator-provided routing policy override (partial or full). */
export function setRoutingPolicy(policy: Partial<RoutingPolicy>): RoutingPolicy {
  const merged: RoutingPolicy = { ...getRoutingPolicy(), ...policy };
  writeKeyValue(JSON.stringify(merged));
  return merged;
}

/** Reset the routing policy to defaults (deletes the override row). */
export function resetRoutingPolicy(): RoutingPolicy {
  const db = getDbInstance();
  db.prepare(`DELETE FROM key_value WHERE namespace = ? AND key = ?`).run(NAMESPACE, KEY);
  return DEFAULT_ROUTING_POLICY;
}
