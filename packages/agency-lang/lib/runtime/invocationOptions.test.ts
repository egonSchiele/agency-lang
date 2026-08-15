import { describe, it, expect } from "vitest";
import { resolveInvocation } from "./invocationOptions.js";

describe("resolveInvocation — run id policy", () => {
  it("prefers an inherited subprocess run id over a supplied trace id", () => {
    const resolved = resolveInvocation({
      kind: "fresh",
      inheritedRunId: "parent-run",
      options: { traceId: "requested-run" },
    });
    expect(resolved.runId).toBe("parent-run");
  });

  it("uses a supplied trace id when there is no inherited id", () => {
    const resolved = resolveInvocation({
      kind: "fresh",
      options: { traceId: "requested-run" },
    });
    expect(resolved.runId).toBe("requested-run");
  });

  it("generates a non-empty id when nothing is supplied", () => {
    const resolved = resolveInvocation({ kind: "fresh" });
    expect(resolved.runId.length).toBeGreaterThan(0);
  });

  it("rejects a supplied empty trace id on a fresh run", () => {
    expect(() => resolveInvocation({ kind: "fresh", options: { traceId: "" } })).toThrow(
      "traceId must not be empty",
    );
  });

  it("always keeps interrupt.runId on a resume, ignoring a supplied trace id", () => {
    const resolved = resolveInvocation({
      kind: "resume",
      runId: "original-run",
      options: { traceId: "ignored-run" },
    });
    expect(resolved.runId).toBe("original-run");
  });

  it("ignores an empty supplied trace id on a resume (no throw)", () => {
    const resolved = resolveInvocation({
      kind: "resume",
      runId: "original-run",
      options: { traceId: "" },
    });
    expect(resolved.runId).toBe("original-run");
  });
});

describe("resolveInvocation — config projection", () => {
  it("copies only the v1 allow-listed fields into the context override", () => {
    const resolved = resolveInvocation({
      kind: "fresh",
      options: {
        traceId: "run",
        config: {
          observability: true,
          log: {
            host: "https://logs.example",
            apiKey: "secret",
            projectId: "project",
            requestTimeoutMs: 500,
            metadata: { environment: "test" },
            logFile: "/tmp/should-be-dropped.log",
            debugMode: true,
          },
          budget: { maxCost: 1, maxTime: "30s" },
          maxCallDepth: 12,
          failurePropagation: "off",
          traceFile: "/tmp/evil.trace",
          traceDir: "/tmp/evil",
          client: {
            defaultModel: "gpt-x",
            providerModules: ["/tmp/evil.js"],
          },
          outDir: "dist",
        },
      },
    });

    expect(resolved.contextOverride).toEqual({
      observability: true,
      log: {
        host: "https://logs.example",
        apiKey: "secret",
        projectId: "project",
        requestTimeoutMs: 500,
        metadata: { environment: "test" },
      },
      budget: { maxCost: 1, maxTime: "30s" },
      maxCallDepth: 12,
      failurePropagation: "off",
    });
  });

  it("returns no context override when no supported field is supplied", () => {
    const resolved = resolveInvocation({
      kind: "fresh",
      options: {
        traceId: "run",
        config: { traceFile: "/tmp/x", client: { defaultModel: "m" } },
      },
    });
    expect(resolved.contextOverride).toBeUndefined();
  });

  it("returns no context override when there is no config at all", () => {
    const resolved = resolveInvocation({ kind: "fresh", options: { traceId: "run" } });
    expect(resolved.contextOverride).toBeUndefined();
  });
});
