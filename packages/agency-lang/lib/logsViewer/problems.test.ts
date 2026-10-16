import { describe, expect, it } from "vitest";
import { runStatus, traceErrors } from "./problems.js";
import { leaf, span, trace } from "./timeline/fixture.js";

describe("traceErrors", () => {
  it("folds a rethrow logged up a call stack into one error with a count", () => {
    const root = trace([
      span(
        "toolExecution",
        [
          leaf("toolCallStart", 100, { toolName: "outer" }),
          span(
            "toolExecution",
            [
              leaf("toolCallStart", 110, { toolName: "inner" }),
              leaf("error", 200, { message: "Resume desync", errorType: "runtimeError" }),
            ],
            { id: "inner" },
          ),
          leaf("error", 205, { message: "Resume desync", errorType: "runtimeError" }),
        ],
        { id: "outer" },
      ),
      leaf("error", 210, { message: "Resume desync", errorType: "runtimeError" }),
    ]);
    const errors = traceErrors(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "Resume desync", count: 3, toolId: "inner" });
    expect(errors[0].errorType).toBe("runtimeError");
  });

  it("keeps two sibling tools failing the same way as two errors", () => {
    const root = trace([
      span("toolExecution", [leaf("error", 100, { message: "bad spec" })], { id: "a" }),
      span("toolExecution", [leaf("error", 100, { message: "bad spec" })], { id: "b" }),
    ]);
    expect(traceErrors(root).map((error) => error.toolId)).toEqual(["a", "b"]);
  });

  it("keeps the same message a second apart as two errors", () => {
    const root = trace([
      leaf("error", 100, { message: "timeout" }),
      leaf("error", 1_200, { message: "timeout" }),
    ]);
    expect(traceErrors(root).map((error) => error.count)).toEqual([1, 1]);
  });

  it("records an error between calls with no tool", () => {
    const root = trace([leaf("error", 100, { message: "hook failed" })]);
    expect(traceErrors(root)[0]).toMatchObject({ toolId: undefined, count: 1, at: 100 });
  });
});

describe("runStatus", () => {
  const start = (at: number) => leaf("agentStart", at, { entryNode: "main" });

  it("is done after a footer with a result", () => {
    expect(runStatus(trace([start(0), leaf("agentEnd", 50, { result: "ok" })]))).toBe("done");
  });

  it("is done after a footer whose result was nothing, when nothing went wrong", () => {
    expect(runStatus(trace([start(0), leaf("agentEnd", 50, {})]))).toBe("done");
  });

  it("is crashed after the runtime error that precedes a footer with no result", () => {
    expect(
      runStatus(
        trace([
          start(0),
          leaf("error", 20, { message: "boom", errorType: "runtimeError" }),
          leaf("agentEnd", 50, {}),
        ]),
      ),
    ).toBe("crashed");
  });

  it("is done when a tool failed, the model moved on, and the node returned nothing", () => {
    expect(
      runStatus(
        trace([
          start(0),
          span(
            "toolExecution",
            [
              leaf("toolCallStart", 10, { toolName: "write" }),
              leaf("error", 20, { message: "disk full", errorType: "toolError" }),
            ],
            { id: "t" },
          ),
          leaf("promptCompletion", 30, { timeTaken: 5, completion: { output: "gave up" } }),
          leaf("agentEnd", 50, {}),
        ]),
      ),
    ).toBe("done");
  });

  it("is paused while an interrupt waits on a person, whether a handler sent it up or none decided", () => {
    for (const outcome of ["propagated", "passed"]) {
      const root = trace([
        start(0),
        leaf("interruptThrown", 10, { interruptId: "i1" }),
        leaf("interruptResolved", 11, { interruptId: "i1", outcome, resolvedBy: null }),
      ]);
      expect(runStatus(root), outcome).toBe("paused");
    }
  });

  it("is running once the person answered and the run has not ended", () => {
    const root = trace([
      start(0),
      leaf("interruptResolved", 11, { interruptId: "i1", outcome: "passed" }),
      start(20),
      leaf("interruptResolved", 21, { interruptId: "i1", outcome: "approved", resolvedBy: "user" }),
    ]);
    expect(runStatus(root)).toBe("running");
  });

  it("reads the latest run of a resumed trace", () => {
    const root = trace([
      start(0),
      leaf("interruptResolved", 11, { interruptId: "i1", outcome: "passed" }),
      start(20),
      leaf("interruptResolved", 21, { interruptId: "i1", outcome: "approved", resolvedBy: "user" }),
      leaf("agentEnd", 30, { result: "ok" }),
    ]);
    expect(runStatus(root)).toBe("done");
  });

  it("falls back to open work when a log has no lifecycle events", () => {
    expect(
      runStatus(trace([span("toolExecution", [leaf("toolCallStart", 100)], { id: "t" })])),
    ).toBe("running");
    expect(runStatus(trace([leaf("promptCompletion", 100, { timeTaken: 10 })]))).toBe("done");
  });
});
