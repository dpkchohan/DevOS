/**
 * Regression test: every sidebar item's `i18nKey` must resolve in the
 * canonical English locale file.
 *
 * Root cause of the reported live error:
 *   MISSING_MESSAGE: Could not resolve `sidebar.orchestration` in messages
 *   for locale `en`.
 * `Header.tsx`'s `usePageInfo()` calls `useTranslations("sidebar")(item.i18nKey)`
 * for whatever sidebar item matches the current route — the DEvOS
 * orchestration dashboard page (`/dashboard/orchestration`) maps to the
 * `orchestration` sidebar item (`sections.ts`), whose `i18nKey` is
 * `"orchestration"`, but `src/i18n/messages/en.json`'s `sidebar` namespace
 * never had that key. This test locks that every `i18nKey` referenced by
 * `SIDEBAR_SECTIONS` has a corresponding entry in `en.json`'s `sidebar` block,
 * so a missing translation for the DEvOS page (or any future page) fails a
 * fast, local test instead of only surfacing at runtime.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SIDEBAR_SECTIONS } from "../../src/shared/constants/sidebarVisibility/sections.ts";
import type { SidebarSectionChild } from "../../src/shared/constants/sidebarVisibility/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function collectI18nKeys(children: readonly SidebarSectionChild[]): string[] {
  const keys: string[] = [];
  for (const child of children) {
    if ("type" in child && child.type === "group") {
      keys.push(...child.items.map((item) => item.i18nKey));
    } else {
      keys.push(child.i18nKey);
    }
  }
  return keys;
}

describe("sidebar i18n coverage", () => {
  it("every sidebar item's i18nKey resolves in en.json's sidebar namespace", () => {
    const enJsonPath = path.join(__dirname, "..", "..", "src", "i18n", "messages", "en.json");
    const messages = JSON.parse(fs.readFileSync(enJsonPath, "utf8")) as {
      sidebar?: Record<string, unknown>;
    };
    const sidebarMessages = messages.sidebar ?? {};

    const allKeys = SIDEBAR_SECTIONS.flatMap((section) => collectI18nKeys(section.children));
    const missing = allKeys.filter((key) => !(key in sidebarMessages));

    assert.deepEqual(
      missing,
      [],
      `Missing sidebar.* translations in en.json for: ${missing.join(", ")}`
    );
  });

  it("the orchestration dashboard sidebar item specifically resolves (regression for the reported bug)", () => {
    const enJsonPath = path.join(__dirname, "..", "..", "src", "i18n", "messages", "en.json");
    const messages = JSON.parse(fs.readFileSync(enJsonPath, "utf8")) as {
      sidebar?: Record<string, unknown>;
    };
    assert.equal(typeof messages.sidebar?.orchestration, "string");
    assert.ok((messages.sidebar?.orchestration as string).length > 0);
  });
});
