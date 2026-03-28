import { describe, it, expect } from "vitest";
import { applyOverrides } from "./rewind.js";
import type { Checkpoint } from "./state/checkpointStore.js";

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 1,
    nodeId: "main",
    stack: {
      stack: [
        {
          args: { message: "hello" },
          locals: { mood: "sad", confidence: 0.9 },
          threads: null,
          step: 3,
        },
      ],
      mode: "serialize" as const,
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: ["main"],
    },
    globals: {
      store: {},
      initializedModules: [],
    },
    ...overrides,
  };
}

describe("applyOverrides", () => {
  it("should override a single local variable", () => {
    const checkpoint = makeCheckpoint();
    applyOverrides(checkpoint, { mood: "happy" });
    expect(checkpoint.stack.stack[0].locals.mood).toBe("happy");
  });

  it("should override multiple local variables", () => {
    const checkpoint = makeCheckpoint();
    applyOverrides(checkpoint, { mood: "happy", confidence: 0.5 });
    expect(checkpoint.stack.stack[0].locals.mood).toBe("happy");
    expect(checkpoint.stack.stack[0].locals.confidence).toBe(0.5);
  });

  it("should add new variables to locals", () => {
    const checkpoint = makeCheckpoint();
    applyOverrides(checkpoint, { newVar: "test" });
    expect(checkpoint.stack.stack[0].locals.newVar).toBe("test");
  });

  it("should not modify args or other frame properties", () => {
    const checkpoint = makeCheckpoint();
    applyOverrides(checkpoint, { mood: "happy" });
    expect(checkpoint.stack.stack[0].args).toEqual({ message: "hello" });
    expect(checkpoint.stack.stack[0].step).toBe(3);
  });

  it("should modify the last frame when there are multiple frames", () => {
    const checkpoint = makeCheckpoint({
      stack: {
        stack: [
          {
            args: {},
            locals: { x: 1 },
            threads: null,
            step: 0,
          },
          {
            args: {},
            locals: { mood: "sad" },
            threads: null,
            step: 3,
          },
        ],
        mode: "serialize" as const,
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    applyOverrides(checkpoint, { mood: "happy" });
    // First frame unchanged
    expect(checkpoint.stack.stack[0].locals.x).toBe(1);
    // Last frame modified
    expect(checkpoint.stack.stack[1].locals.mood).toBe("happy");
  });
});
