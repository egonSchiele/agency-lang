import { describe, expect, it } from "vitest";
import { parseAgency } from "../../parser.js";
import { declaredName } from "../../types/hole.js";
import { walkNodes } from "../../utils/node.js";
import { DRIVER_NAMES, DRIVER_NODES, driverSource } from "./driver.js";

const MEAL_IMPORTS = [
  { module: "./notes.agency", names: ["searchNotes", "readNote"] },
  { module: "std::math", names: ["round"] },
];

const PROJECT = "/p/proj";
const DRIVER_DIR = "/p/proj/.agency-tmp/workflow-abc";

function parsed(source: string) {
  const result = parseAgency(source, {}, false);
  if (!result.success) {
    throw new Error(`the driver does not parse: ${JSON.stringify(result)}`);
  }
  return result.result;
}

describe("driverSource", () => {
  it("writes the imports relative to the driver's folder and lists the tools", () => {
    const source = driverSource(MEAL_IMPORTS, PROJECT, DRIVER_DIR);
    expect(source.split("\n").slice(0, 4)).toEqual([
      'import { catalog as wfCatalog, loadWorkflow as wfLoad, checkWorkflow as wfCheck, compileWorkflow as wfCompile, listWorkflows as wfList } from "std::workflow"',
      'import { searchNotes, readNote } from "../../notes.agency"',
      'import { round } from "std::math"',
      "",
    ]);
    expect(source).toContain("const wfTools = [searchNotes, readNote, round]\n");
  });

  it("parses, with imports and with none", () => {
    parsed(driverSource(MEAL_IMPORTS, PROJECT, DRIVER_DIR));
    parsed(driverSource([], PROJECT, DRIVER_DIR));
  });

  it("binds only names in DRIVER_NAMES, and has every node in DRIVER_NODES", () => {
    const program = parsed(driverSource([], PROJECT, DRIVER_DIR));
    const bound: string[] = [];
    for (const { node } of walkNodes(program.nodes)) {
      if (node.type === "importStatement") {
        for (const group of node.importedNames) {
          if (group.type === "namedImport") {
            bound.push(...Object.values(group.aliases ?? {}));
          }
        }
      }
      if (node.type === "graphNode") {
        bound.push(declaredName(node.nodeName));
      }
      if (node.type === "assignment") {
        bound.push(node.variableName);
      }
    }
    expect(bound.filter((name) => !DRIVER_NAMES.includes(name))).toEqual([]);
    for (const nodeName of Object.values(DRIVER_NODES)) {
      expect(bound).toContain(nodeName);
    }
  });
});
