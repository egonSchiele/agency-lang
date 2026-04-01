import { describe, it, expect } from "vitest";
import { RuntimeContext } from "./context.js";

function makeMockCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
}

describe("RuntimeContext", () => {
  it("should initialize debugger field as null", () => {
    const ctx = makeMockCtx();
    expect(ctx.debuggerState).toBeNull();
  });
});
