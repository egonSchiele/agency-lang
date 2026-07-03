import { describe, it, expect } from "vitest";
import { prunePreludeShadows } from "./prunePreludeShadows.js";
import type { AgencyProgram } from "../types.js";

const preludeImport = () => ({
  type: "importStatement" as const,
  modulePath: "std::index",
  importedNames: [
    {
      type: "namedImport" as const,
      importedNames: ["map", "filter", "count", "range"],
      safeNames: ["range"],
      aliases: {} as Record<string, string>,
    },
  ],
});

describe("prunePreludeShadows", () => {
  it("drops prelude names shadowed by a top-level def or global, keeping the rest", () => {
    const program = {
      type: "agencyProgram",
      nodes: [
        preludeImport(),
        // shadows the prelude `map`
        { type: "function", functionName: "map", parameters: [], body: [] },
        // shadows the prelude `count` global
        {
          type: "assignment",
          declKind: "let",
          variableName: "count",
          value: { type: "number", value: "0" },
        },
      ],
    } as unknown as AgencyProgram;

    prunePreludeShadows(program);

    const imp = program.nodes.find((n) => n.type === "importStatement") as any;
    expect(imp.importedNames[0].importedNames).toEqual(["filter", "range"]);
    expect(imp.importedNames[0].safeNames).toEqual(["range"]);
  });

  it("ignores a bare re-assignment (no declKind) — only real declarations shadow", () => {
    const program = {
      type: "agencyProgram",
      nodes: [
        preludeImport(),
        // `count = 1` with no `let`/`const` is not a new binding
        { type: "assignment", variableName: "count", value: { type: "number", value: "1" } },
      ],
    } as unknown as AgencyProgram;

    prunePreludeShadows(program);

    const imp = program.nodes.find((n) => n.type === "importStatement") as any;
    expect(imp.importedNames[0].importedNames).toContain("count");
  });

  it("leaves the import untouched when nothing is shadowed", () => {
    const program = {
      type: "agencyProgram",
      nodes: [
        preludeImport(),
        { type: "graphNode", nodeName: "main", parameters: [], body: [] },
      ],
    } as unknown as AgencyProgram;

    prunePreludeShadows(program);

    const imp = program.nodes.find((n) => n.type === "importStatement") as any;
    expect(imp.importedNames[0].importedNames).toEqual([
      "map",
      "filter",
      "count",
      "range",
    ]);
  });

  it("does not prune imports from modules other than std::index", () => {
    const program = {
      type: "agencyProgram",
      nodes: [
        {
          type: "importStatement",
          modulePath: "std::object",
          importedNames: [
            {
              type: "namedImport",
              importedNames: ["mapValues"],
              safeNames: [],
              aliases: {},
            },
          ],
        },
        { type: "function", functionName: "mapValues", parameters: [], body: [] },
      ],
    } as unknown as AgencyProgram;

    prunePreludeShadows(program);

    const imp = program.nodes.find((n) => n.type === "importStatement") as any;
    expect(imp.importedNames[0].importedNames).toEqual(["mapValues"]);
  });

  it("removes a std::index import entirely once all its names are shadowed", () => {
    const program = {
      type: "agencyProgram",
      nodes: [
        {
          type: "importStatement",
          modulePath: "std::index",
          importedNames: [
            {
              type: "namedImport",
              importedNames: ["map"],
              safeNames: [],
              aliases: {},
            },
          ],
        },
        { type: "function", functionName: "map", parameters: [], body: [] },
      ],
    } as unknown as AgencyProgram;

    prunePreludeShadows(program);

    expect(program.nodes.some((n) => n.type === "importStatement")).toBe(false);
  });
});
