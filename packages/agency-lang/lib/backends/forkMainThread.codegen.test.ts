import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";
import { walkNodes } from "../utils/node.js";
import type { FunctionCall } from "../types.js";

// `mainThread` is a field the `async` lowering sets on the fork it writes,
// never a named argument. The builder passes it as the trailing argument of
// `runner.fork(...)`, after `shared`. These tests set the field by hand on a
// parsed fork and read the emitted call.

const SRC = `def work(item: string): string {
  return item
}

node main() {
  const results = fork(["a", "b"]) as item {
    return work(item)
  }
  return results
}
`;

function gen(mainThread: number | undefined): string {
  const parsed = parseAgency(SRC, {}, false);
  if (!parsed.success) throw new Error("parse failed: " + parsed.message);
  const forks = [...walkNodes(parsed.result.nodes)]
    .map(({ node }) => node)
    .filter(
      (node): node is FunctionCall => node.type === "functionCall" && node.functionName === "fork",
    );
  expect(forks).toHaveLength(1);
  if (mainThread !== undefined) forks[0].mainThread = mainThread;
  return generateTypeScript(parsed.result, undefined, undefined, "test.agency");
}

describe("runner.fork's mainThread argument", () => {
  it("passes the field as the trailing argument", () => {
    expect(gen(1)).toContain(`"all", __run.stack, false, 1);`);
  });

  it("passes undefined when the field is absent", () => {
    expect(gen(undefined)).toContain(`"all", __run.stack, false, undefined);`);
  });
});
