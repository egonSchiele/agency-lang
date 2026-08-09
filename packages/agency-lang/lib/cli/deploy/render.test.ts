import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderOutcome } from "./render.js";
import type { DeployOutcome, DeployPlan } from "./deploy.js";

const plan: DeployPlan = {
  target: { host: "https://h", projectId: "proj", apiKey: "secret-key" },
  provenance: { host: "--host", projectId: "--project", apiKey: "$STATELOG_API_KEY" },
  bundle: {
    entrypoint: "daily.agency",
    files: [{ name: "daily.agency", contents: "x", absPath: "/tmp/daily.agency" }],
  },
};

function deployed(overrides: Partial<Extract<DeployOutcome, { kind: "deployed" }>>): DeployOutcome {
  return {
    kind: "deployed",
    plan,
    endpointUrls: ["https://h/serve/u/proj/daily/list"],
    manifest: undefined,
    removedFiles: [],
    orphanedSchedules: [],
    ...overrides,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

function output(): string {
  return logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderOutcome bundle replacement", () => {
  it("prints removed files and orphaned-schedule warnings", () => {
    renderOutcome(
      deployed({
        removedFiles: ["helpers.agency"],
        orphanedSchedules: [
          { id: "s1", name: "mine", fileName: "helpers", targetKind: "node", targetName: "refresh" },
        ],
      }),
    );
    expect(output()).toContain("Replaced previous bundle");
    expect(output()).toContain("helpers.agency");
    expect(output()).toContain("schedule s1 (mine)");
    expect(output()).toContain("node refresh");
  });

  it("prints no replacement section when nothing was removed", () => {
    renderOutcome(deployed({}));
    expect(output()).not.toContain("Replaced previous bundle");
  });

  it("never prints the API key", () => {
    renderOutcome(deployed({ removedFiles: ["helpers.agency"], orphanedSchedules: [] }));
    expect(output()).not.toContain("secret-key");
  });
});
