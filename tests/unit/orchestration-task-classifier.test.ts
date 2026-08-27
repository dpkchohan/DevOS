/**
 * Task Classifier tests — Orchestration Phase 3.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyTask } from "../../src/domain/orchestration/taskClassifier.ts";

describe("classifyTask", () => {
  it("classifies a security-sensitive task as critical regardless of length", () => {
    const result = classifyTask("Rotate the API keys used for the auth service.");
    assert.equal(result.complexity, "critical");
    assert.equal(result.humanConfirmationRequired, true);
    assert.ok(result.risk >= 0.8);
  });

  it("classifies an architecture-level task as complex", () => {
    const result = classifyTask(
      "Refactor the architecture to support a distributed job queue across services."
    );
    assert.equal(result.complexity, "complex");
    assert.equal(result.architectureImpact, true);
  });

  it("classifies a feature-addition task as moderate", () => {
    const result = classifyTask("Add a new API endpoint for exporting user reports.");
    assert.equal(result.complexity, "moderate");
    assert.equal(result.repoExplorationRequired, true);
  });

  it("classifies a short trivial fix as trivial", () => {
    const result = classifyTask("Fix a typo in the README.");
    assert.equal(result.complexity, "trivial");
    assert.equal(result.testingRequired, false);
  });

  it("classifies a short generic request as simple", () => {
    const result = classifyTask("Add a console.log statement here.");
    assert.equal(result.complexity, "simple");
  });

  it("estimates file count from explicit file paths in the request", () => {
    const result = classifyTask(
      "Update src/lib/foo.ts and src/lib/bar.ts to add a new field, add a feature."
    );
    assert.ok(result.estimatedFileCount >= 2);
  });

  it("never downgrades a critical signal even in a long request with many moderate keywords", () => {
    const result = classifyTask(
      "Implement a new feature that adds an endpoint and also touches the password reset credential flow."
    );
    assert.equal(result.complexity, "critical");
  });

  it("supports custom keyword configuration", () => {
    const result = classifyTask("Please adjust the wombat sync logic.", {
      criticalKeywords: ["wombat"],
    });
    assert.equal(result.complexity, "critical");
  });
});
