import { beforeEach, describe, expect, it } from "vitest";
import {
  __getRegisteredModules,
  __registerModule,
  __resetModuleRegistry,
  type ModuleInitHandle,
} from "./initOrchestrator.js";

function makeHandle(moduleId: string): ModuleInitHandle {
  return {
    __moduleId: moduleId,
    __initializeStatic: async () => {},
    __runImperatives: async () => {},
  };
}

describe("__registerModule", () => {
  beforeEach(() => {
    __resetModuleRegistry();
  });

  it("appends new module ids in registration (DFS) order", () => {
    __registerModule(makeHandle("a"));
    __registerModule(makeHandle("b"));
    __registerModule(makeHandle("c"));

    expect(__getRegisteredModules().map((m) => m.__moduleId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("last-write-wins: re-registering the same moduleId replaces the handles in place", () => {
    const first = makeHandle("hot");
    const second = makeHandle("hot");
    __registerModule(makeHandle("before"));
    __registerModule(first);
    __registerModule(makeHandle("after"));

    __registerModule(second); // simulates HMR / cache-bust re-import

    const registered = __getRegisteredModules();
    expect(registered.map((m) => m.__moduleId)).toEqual([
      "before",
      "hot",
      "after",
    ]);
    // The slot still holds "hot", but the handles are the fresh ones.
    expect(registered[1]).toBe(second);
    expect(registered[1]).not.toBe(first);
  });
});
