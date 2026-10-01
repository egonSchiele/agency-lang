import { describe, it, expect } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { type ThreadedStore, ctxOf, threadsOf, deriveStore, bindStore } from "./threadedContext.js";

function makeStore(tag: string): ThreadedStore {
  return {
    ctx: `ctx:${tag}`,
    stack: `stack:${tag}`,
    threads: `threads:${tag}`,
    globals: `globals:${tag}`,
  };
}

describe("compiler-threaded context (spike)", () => {
  it("reads the frame across awaits with no async_hooks", async () => {
    const store = makeStore("root");

    // Stands in for a generated Agency function: it receives the frame and
    // reads context from it, with awaits in between.
    async function inner(__store: ThreadedStore): Promise<unknown> {
      await Promise.resolve();
      return ctxOf(__store);
    }
    async function outer(__store: ThreadedStore): Promise<unknown> {
      await Promise.resolve();
      return inner(__store); // forward the threaded frame to the callee
    }

    expect(await outer(store)).toBe("ctx:root");
  });

  it("a child scope overrides one slot without disturbing the parent (fork-like)", () => {
    const parent = makeStore("parent");
    const child = deriveStore(parent, { stack: "branch-stack" });

    expect(threadsOf(child)).toBe("threads:parent"); // inherited
    expect(child.stack).toBe("branch-stack"); // overridden for the branch
    expect(parent.stack).toBe("stack:parent"); // parent frame untouched
  });

  it("escaping callbacks are the hard case: the frame must be captured explicitly", async () => {
    const store = makeStore("root");

    // A raw event-loop callback has no caller to thread the frame from, so it
    // cannot see any context. This is exactly what ALS solves implicitly.
    const raw = (): ThreadedStore | undefined => undefined;
    expect(raw()).toBeUndefined();

    // Explicit threading answer: capture the frame and re-bind it.
    const bound = bindStore(store, (__store) => ctxOf(__store));
    const viaTimer = await new Promise((resolve) => setTimeout(() => resolve(bound()), 0));
    expect(viaTimer).toBe("ctx:root");
  });

  it("contrast: ALS carries context across that same callback for free (the cost of dropping it)", async () => {
    const als = new AsyncLocalStorage<ThreadedStore>();
    const store = makeStore("root");

    const result = await als.run(
      store,
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve((als.getStore() as ThreadedStore).ctx), 0),
        ),
    );

    expect(result).toBe("ctx:root");
  });
});
