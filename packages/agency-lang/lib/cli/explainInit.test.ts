import { describe, it, expect } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import { renderExplainInit } from "./explainInit.js";
import { buildCompiledClosure } from "../compiler/compileClosure.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(
  __dirname,
  "..",
  "..",
  "tests",
  "cli",
  "explainInitFixtures",
);

function explain(file: string): string {
  const closure = buildCompiledClosure(path.join(FIXTURES, file), {});
  // Strip the fixtures directory from any absolute paths in the
  // output so the snapshot is portable across machines / CI.
  return renderExplainInit(closure).replace(
    new RegExp(escapeRegex(FIXTURES + path.sep), "g"),
    "",
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("explainInit", () => {
  it("single-file static + global mix", () => {
    expect(explain("single-static.agency")).toMatchInlineSnapshot(`
      "Phase A (once per process):
        single-static.agency:4   greeting
        single-static.agency:5   banner

      Phase B (every run):
        single-static.agency:7   log
        single-static.agency:8   <bare statement>

      Variable dependency graph:
        single-static.greeting   (no deps)
        single-static.banner   depends on: single-static.greeting
        single-static.log   (no deps)
        single-static.<bare statement>   depends on: single-static.log

      Cyclic imports detected (allowed): none"
    `);
  });

  it("cross-module static dep", () => {
    expect(explain("cross-module-main.agency")).toMatchInlineSnapshot(`
      "Phase A (once per process):
        cross-module-helper.agency:1   greeting
        cross-module-main.agency:6   composed

      Phase B (every run):
        (nothing)

      Variable dependency graph:
        cross-module-helper.greeting   (no deps)
        cross-module-main.composed   depends on: cross-module-helper.greeting

      Cyclic imports detected (allowed): none"
    `);
  });

  it("cyclic file-level imports (no var-level cycle)", () => {
    expect(explain("cyclic-a.agency")).toMatchInlineSnapshot(`
      "Phase A (once per process):
        (nothing)

      Phase B (every run):
        (nothing)

      Variable dependency graph:
        (no top-level variables)

      Cyclic imports detected (allowed):
        cyclic-a.agency ⇄ cyclic-b.agency"
    `);
  });
});
