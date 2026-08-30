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

  it("falls back to the environment's trace id below a supplied one, and ignores an empty one", () => {
    expect(resolveInvocation({ kind: "fresh", environmentTraceId: "harness-run" }).runId).toBe(
      "harness-run",
    );
    expect(
      resolveInvocation({
        kind: "fresh",
        options: { traceId: "requested-run" },
        environmentTraceId: "harness-run",
      }).runId,
    ).toBe("requested-run");
    expect(
      resolveInvocation({ kind: "fresh", environmentTraceId: "" }).runId.length,
    ).toBeGreaterThan(0);
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

describe("resolveInvocation — policy", () => {
  const policy = { "std::env": [{ match: { name: "A" }, action: "approve" as const }] };

  it("puts a valid policy on the resolved invocation for a fresh run", () => {
    const resolved = resolveInvocation({ kind: "fresh", options: { policy } });
    expect(resolved.policy).toBe(policy);
  });

  it("puts a valid policy on the resolved invocation for a resume", () => {
    const resolved = resolveInvocation({ kind: "resume", runId: "run", options: { policy } });
    expect(resolved.policy).toBe(policy);
  });

  it("resolves to no policy when none was supplied", () => {
    expect(resolveInvocation({ kind: "fresh" }).policy).toBeUndefined();
    expect(resolveInvocation({ kind: "resume", runId: "run" }).policy).toBeUndefined();
  });

  it("throws a prefixed error naming the schema problem on an invalid policy", () => {
    const invalid = { "std::env": [{ action: "allow" }] } as never;
    for (const request of [
      { kind: "fresh" as const, options: { policy: invalid } },
      { kind: "resume" as const, runId: "run", options: { policy: invalid } },
    ]) {
      expect(() => resolveInvocation(request)).toThrow(/^invalid invocation policy: /);
      // The message names the schema problem, so a host log is actionable.
      expect(() => resolveInvocation(request)).toThrow(/action/);
    }
  });
});
