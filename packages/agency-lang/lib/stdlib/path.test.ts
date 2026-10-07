import { describe, expect, it } from "vitest";
import { _relative, _resolve } from "./path.js";
import { memoryHost } from "../host/memoryHost.js";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";

/** Run `fn` inside a run whose host has `cwd` as its working directory. */
function withCwd<T>(cwd: string, fn: () => T): Promise<T> {
  const ctx = new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: cwd,
    host: memoryHost({ cwd }),
  });
  return runInTestContext(ctx, new StateStack(), new ThreadStore(), async () => fn());
}

describe("std::path", () => {
  it("resolves from the run's working directory", async () => {
    expect(await withCwd("/work/project", () => _resolve(["a", "b"]))).toBe("/work/project/a/b");
    expect(await withCwd("/work/project", () => _resolve(["/abs", "c"]))).toBe("/abs/c");
  });

  it("takes relative inputs to relative from the run's working directory", async () => {
    // Neither argument is absolute, so without the run's cwd the portable
    // module would reach for process.cwd(), which a browser has none of.
    expect(await withCwd("/work/project", () => _relative("a", "b"))).toBe("../b");
    expect(await withCwd("/work/project", () => _relative("a/b", "a/b/c/d"))).toBe("c/d");
    expect(await withCwd("/work/project", () => _relative("/work/project/a", "b"))).toBe("../b");
  });
});
