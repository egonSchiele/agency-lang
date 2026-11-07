import { describe, expect, it } from "vitest";
import { errorsWithCode } from "./castTestUtils.js";
import { gotoRefusals } from "./gotoChecks.js";
import { parseAgency } from "../parser.js";

const PRELUDE = `def twice(block: () => any): any {
  return block()
}

node done(x: string) {
  return x
}
`;

const inMain = (body: string) => `${PRELUDE}node main() {\n${body}\n  return "after"\n}\n`;
const refusals = (source: string) => errorsWithCode(source, "AG1036");

/** The codes the compile path reports, which runs on the parsed tree with
 *  the type checker off, so a guard block is still a `guardBlock`. */
const compilePathCodes = (source: string) => {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error(parsed.message);
  return gotoRefusals(parsed.result.nodes).map((error) => error.code);
};

describe("a goto inside a block is refused (AG1036)", () => {
  const refused: [string, string][] = [
    ["a block argument", `  const r = twice() as {\n    goto done("block")\n  }`],
    ["a fork branch", `  const r = fork([1, 2]) as item {\n    goto done("fork")\n  }`],
    [
      "an inline handler function",
      `  handle {\n    print("a")\n  } with (intr) {\n    goto done("handler")\n  }`,
    ],
    ["a guard block", `  const r = guard(cost: 1.0) {\n    goto done("guard")\n  }`],
    [
      "a parallel arm, inside seq",
      `  parallel {\n    seq {\n      goto done("parallel")\n    }\n    print("b")\n  }`,
    ],
    ["a finalize block", `  print("a")\n\n  finalize {\n    goto done("finalize")\n  }`],
    [
      "an if inside a block argument",
      `  const r = twice() as {\n    if (true) {\n      goto done("nested")\n    }\n    return 1\n  }`,
    ],
  ];

  for (const [where, body] of refused) {
    it(`in ${where}`, () => {
      expect(refusals(inMain(body))).toHaveLength(1);
      expect(compilePathCodes(inMain(body))).toEqual(["AG1036"]);
    });
  }

  it("names the target node in the message", () => {
    const [error] = refusals(inMain(`  const r = twice() as {\n    goto done("block")\n  }`));
    expect(error.message).toContain("`goto done`");
  });
});

describe("a goto in the node's own body is allowed", () => {
  const allowed: [string, string][] = [
    ["an if", `  if (true) {\n    goto done("if")\n  }`],
    ["a for loop", `  for (x in [1]) {\n    goto done("for")\n  }`],
    ["a thread block", `  thread {\n    goto done("thread")\n  }`],
    ["a handle body", `  handle {\n    goto done("handle")\n  } with approve`],
    ["a match arm", `  match("a") {\n    "a" => goto done("match")\n    _ => print("b")\n  }`],
  ];

  for (const [where, body] of allowed) {
    it(`in ${where}`, () => {
      expect(refusals(inMain(body))).toEqual([]);
      expect(compilePathCodes(inMain(body))).toEqual([]);
    });
  }
});
