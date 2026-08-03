import { describe, expect, it, vi } from "vitest";

import type { MigrateResult } from "@/eval/label/migrate/migrate.js";

import {
  describeMigration,
  evalLabelMigrate,
  type EvalLabelMigrateDependencies,
} from "./migrate.js";

function result(over: Partial<MigrateResult> = {}): MigrateResult {
  return {
    sourceDir: "/old",
    destDir: "/new",
    oldRecords: 4,
    newRecords: 3,
    mergedGroups: 1,
    occurrences: 4,
    annotations: 2,
    ...over,
  };
}

function dependencies(
  over: Partial<EvalLabelMigrateDependencies> = {},
): { reported: string[]; dependencies: EvalLabelMigrateDependencies } {
  const reported: string[] = [];
  return {
    reported,
    dependencies: {
      migrateStore: vi.fn(() => result()) as never,
      report: (message) => reported.push(message),
      ...over,
    },
  };
}

describe("describeMigration", () => {
  it("reports counts a person can check against their old store", () => {
    const text = describeMigration(result()).join("\n");
    expect(text).toContain("4 old records became 3");
    expect(text).toContain("4 occurrences recorded");
    expect(text).toContain("2 labels carried across");
  });

  it("explains a merge rather than leaving the count unaccounted for", () => {
    expect(describeMigration(result()).join("\n")).toContain("identified by their content");
  });

  it("says nothing about merging when nothing merged", () => {
    const text = describeMigration(result({ oldRecords: 3, newRecords: 3, mergedGroups: 0 }))
      .join("\n");
    expect(text).not.toContain("merged");
  });

  it("states that the original store is intact, because that is the whole promise", () => {
    expect(describeMigration(result()).join("\n")).toContain("was not modified");
  });

  it("uses singular wording for one record", () => {
    const text = describeMigration(result({ oldRecords: 1, newRecords: 1, annotations: 1 }))
      .join("\n");
    expect(text).toContain("1 old record became 1");
    expect(text).toContain("1 label carried across");
  });
});

describe("evalLabelMigrate", () => {
  it("passes both directories through", async () => {
    const migrate = vi.fn(() => result());
    await evalLabelMigrate(
      { sourceDir: "labels", destDir: "labels-v2" },
      dependencies({ migrateStore: migrate as never }).dependencies,
    );
    expect(migrate).toHaveBeenCalledWith(expect.objectContaining({
      sourceDir: "labels",
      destDir: "labels-v2",
    }));
  });

  it("prints the summary", async () => {
    const { reported, dependencies: deps } = dependencies();
    await evalLabelMigrate({ sourceDir: "old", destDir: "new" }, deps);
    expect(reported.join("\n")).toContain("Migrated");
  });

  it("propagates a refusal rather than reporting a partial success", async () => {
    const deps = dependencies({
      migrateStore: vi.fn(() => {
        throw new Error("outputs disagree");
      }) as never,
    });
    await expect(evalLabelMigrate({ sourceDir: "old", destDir: "new" }, deps.dependencies))
      .rejects.toThrow("outputs disagree");
    expect(deps.reported).toEqual([]);
  });
});
