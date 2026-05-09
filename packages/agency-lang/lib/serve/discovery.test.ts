import { describe, expect, it } from "vitest";
import { discoverExports } from "./discovery.js";
import { AgencyFunction } from "../runtime/agencyFunction.js";

describe("discoverExports", () => {
  it("returns exported functions from tool registry", () => {
    const registry: Record<string, AgencyFunction> = {};
    AgencyFunction.create(
      {
        name: "publicFn",
        module: "test",
        fn: async () => {},
        params: [],
        toolDefinition: {
          name: "publicFn",
          description: "A public fn",
          schema: null,
        },
        exported: true,
        safe: false,
      },
      registry,
    );
    AgencyFunction.create(
      {
        name: "privateFn",
        module: "test",
        fn: async () => {},
        params: [],
        toolDefinition: {
          name: "privateFn",
          description: "Private",
          schema: null,
        },
        exported: false,
      },
      registry,
    );

    const exports = discoverExports({
      toolRegistry: registry,
      moduleExports: {},
      moduleId: "test",
    });
    const functions = exports.filter((e) => e.kind === "function");
    expect(functions).toHaveLength(1);
    expect(functions[0].name).toBe("publicFn");
  });

  it("filters by moduleId", () => {
    const registry: Record<string, AgencyFunction> = {};
    AgencyFunction.create(
      {
        name: "myFn",
        module: "myModule",
        fn: async () => {},
        params: [],
        toolDefinition: { name: "myFn", description: "Mine", schema: null },
        exported: true,
      },
      registry,
    );
    AgencyFunction.create(
      {
        name: "stdlibFn",
        module: "stdlib",
        fn: async () => {},
        params: [],
        toolDefinition: { name: "stdlibFn", description: "Stdlib", schema: null },
        exported: true,
      },
      registry,
    );

    const exports = discoverExports({
      toolRegistry: registry,
      moduleExports: {},
      moduleId: "myModule",
    });
    expect(exports).toHaveLength(1);
    expect(exports[0].name).toBe("myFn");
  });

  it("returns exported nodes from module exports", () => {
    const mockNodeFn = async () => ({ data: "result" });
    const moduleExports = {
      main: mockNodeFn,
      __mainNodeParams: ["message"],
    };

    const exports = discoverExports({
      toolRegistry: {},
      moduleExports,
      moduleId: "test",
      exportedNodeNames: ["main"],
    });
    const nodes = exports.filter((e) => e.kind === "node");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("main");
    if (nodes[0].kind === "node") {
      expect(nodes[0].parameters).toEqual([{ name: "message" }]);
      expect(nodes[0].interruptKinds).toEqual([]);
    }
  });

  it("skips non-exported nodes", () => {
    const moduleExports = {
      main: async () => {},
      __mainNodeParams: [],
      helper: async () => {},
      __helperNodeParams: [],
    };

    const exports = discoverExports({
      toolRegistry: {},
      moduleExports,
      moduleId: "test",
      exportedNodeNames: ["main"],
    });
    expect(exports).toHaveLength(1);
    expect(exports[0].name).toBe("main");
  });

  it("returns empty array when no exports found", () => {
    expect(
      discoverExports({ toolRegistry: {}, moduleExports: {}, moduleId: "test" }),
    ).toEqual([]);
  });
});
