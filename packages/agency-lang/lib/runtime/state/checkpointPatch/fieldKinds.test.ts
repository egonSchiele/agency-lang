import { describe, expect, it } from "vitest";
import { fieldKind } from "./fieldKinds.js";

const FRAME = ["stack", "stack", "1"];

describe("fieldKind", () => {
  it("locals are data in a user frame, bookkeeping in the loop's", () => {
    expect(fieldKind([...FRAME, "locals", "foo"], "main")).toBe("data");
    expect(fieldKind([...FRAME, "locals", "toolCallRound"], "main")).toBe("data");
    expect(fieldKind([...FRAME, "locals", "toolCallRound"], "runPrompt")).toBe("control");
    expect(fieldKind([...FRAME, "locals", "runnerState", "completedSteps"], "runPrompt")).toBe(
      "control",
    );
    expect(fieldKind([...FRAME, "locals", "messagesJSON", "messages"], "runPrompt")).toBe("data");
    expect(fieldKind([...FRAME, "locals", "messagesJSON", "queuedMessages"], "runPrompt")).toBe(
      "data",
    );
    expect(fieldKind([...FRAME, "locals", "removedTools"], "runPrompt")).toBe("data");
    expect(fieldKind([...FRAME, "locals", "messagesJSON", "id"], "runPrompt")).toBe("identity");
  });

  it("a program's own variable is data whatever it is called; the loop's are not", () => {
    expect(fieldKind([...FRAME, "locals", "id"], "main")).toBe("data");
    expect(fieldKind([...FRAME, "locals", "step"], "main")).toBe("data");
    expect(fieldKind([...FRAME, "args", "guardId"], "search")).toBe("data");
    expect(fieldKind([...FRAME, "locals", "item"], null)).toBe("data");
    expect(fieldKind(["globals", "store", "mod", "id"], null)).toBe("data");
    expect(fieldKind([...FRAME, "locals", "id"], "runPrompt")).not.toBe("data");
    expect(fieldKind([...FRAME, "locals", "step"], "runPrompt")).not.toBe("data");
  });

  it("a __ name is control in every frame", () => {
    expect(fieldKind([...FRAME, "locals", "__substep_2"], "main")).toBe("control");
    expect(fieldKind([...FRAME, "locals", "__initialized"], "runPrompt")).toBe("control");
  });

  it("step counters, stack bookkeeping, and guard meters are control", () => {
    expect(fieldKind([...FRAME, "step"], "main")).toBe("control");
    expect(fieldKind(["stack", "nodesTraversed"], null)).toBe("control");
    expect(fieldKind(["stack", "deserializeStackLength"], null)).toBe("control");
    expect(fieldKind(["stack", "mode"], null)).toBe("control");
    expect(fieldKind(["stack", "guards", "0", "spent"], null)).toBe("control");
    expect(fieldKind(["stack", "guards", "0", "elapsedMs"], null)).toBe("control");
    expect(fieldKind(["stack", "guards", "0", "costLimit"], null)).toBe("data");
    expect(fieldKind(["stack", "guards", "0", "disarmed"], null)).toBe("data");
  });

  it("ids, fingerprints, the signature, and the trace id are identity", () => {
    expect(fieldKind(["id"], null)).toBe("identity");
    expect(fieldKind(["signature"], null)).toBe("identity");
    expect(fieldKind(["moduleFingerprints"], null)).toBe("identity");
    expect(fieldKind(["traceId"], null)).toBe("identity");
    expect(fieldKind(["stack", "guards", "0", "guardId"], null)).toBe("identity");
    expect(fieldKind([...FRAME, "threads", "threads", "m", "id"], "main")).toBe("identity");
  });

  it("args, threads, branch results, and globals are data", () => {
    expect(fieldKind([...FRAME, "args", "query"], "search")).toBe("data");
    expect(fieldKind([...FRAME, "threads", "threads", "m", "messages"], "main")).toBe("data");
    expect(fieldKind([...FRAME, "branches", "fork_1", "result"], "main")).toBe("data");
    expect(fieldKind(["globals", "store", "mod", "g"], null)).toBe("data");
    expect(
      fieldKind([...FRAME, "branches", "fork_1", "globalsJSON", "store", "mod", "g"], "main"),
    ).toBe("data");
  });
});
