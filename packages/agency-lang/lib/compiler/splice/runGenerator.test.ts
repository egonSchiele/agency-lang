import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { safeDeleteDirectory } from "../../utils.js";
import { parseAgency } from "../../parser.js";
import { walkNodesArray } from "../../utils/node.js";
import { checkNoNestedSplice } from "./eligibility.js";
import { runGenerator } from "./runGenerator.js";
import type { Splice } from "../../types/splice.js";

let dir: string;

beforeEach(() => {
  // Under the project's .agency-tmp/ for the same reason the eligibility
  // tests are: safeDeleteDirectory refuses paths outside the project.
  dir = path.join(process.cwd(), ".agency-tmp", `splice-run-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  safeDeleteDirectory(dir, false);
});

function write(name: string, source: string): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, source, "utf-8");
  return target;
}

/** The splice node inside a host source, found the way the expansion pass
 *  will find it. */
function spliceIn(hostSource: string): Splice {
  const result = parseAgency(hostSource, {}, false, false);
  if (!result.success) {
    throw new Error(result.message ?? "parse failed");
  }
  const found = [...walkNodesArray(result.result.nodes)]
    .map((visit) => visit.node)
    .find((node) => node.type === "splice");
  if (found === undefined) {
    throw new Error("no splice in host source");
  }
  return found as Splice;
}

/** A generator module returning `body`, plus the splice that calls it. */
function generatorReturning(
  body: string,
  params: string = "",
): {
  splice: Splice;
  generator: { modulePath: string; exportedName: string };
} {
  const modulePath = write(
    "gen.agency",
    `import { Code } from "std::agency"\n\nexport def g(${params}): Code {\n${body}\n}\n`,
  );
  return {
    splice: spliceIn(`import { g } from "./gen.agency"\n\n$( g() )\n`),
    generator: { modulePath, exportedName: "g" },
  };
}

describe("runGenerator", () => {
  it("brings back a program fragment", () => {
    // Multi-line on purpose: a one-line `def` inside `[| |]` does not
    // parse. See #681.
    const { splice, generator } = generatorReturning(
      `  return [|\n    def greet(): string {\n      return "hi"\n    }\n  |]`,
    );
    const result = runGenerator(splice, generator, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("agencyProgram");
    expect(result.value.nodes).toHaveLength(1);
    expect((result.value.nodes[0] as { functionName?: string }).functionName).toBe("greet");
  }, 60_000);

  it("brings back an expression fragment", () => {
    const { splice, generator } = generatorReturning(`  return [| 1 + 2 |]`);
    const result = runGenerator(splice, generator, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("expr");
    expect(result.value.nodes).toHaveLength(1);
  }, 60_000);

  it("passes the splice expression's arguments through", () => {
    const modulePath = write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(n: number): Code {\n  if (n > 1) {\n    return [| "big" |]\n  }\n  return [| "small" |]\n}\n`,
    );
    const splice = spliceIn(`import { g } from "./gen.agency"\n\n$( g(5) )\n`);
    const result = runGenerator(splice, { modulePath, exportedName: "g" }, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).toContain("big");
  }, 60_000);

  it("binds an aliased import to the name the splice actually uses", () => {
    const modulePath = write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def makeGetters(): Code {\n  return [| 7 |]\n}\n`,
    );
    // The host renamed it, so the printed expression says `gen`. The
    // runner has to bind that spelling.
    const splice = spliceIn(`import { makeGetters as gen } from "./gen.agency"\n\n$( gen() )\n`);
    const result = runGenerator(splice, { modulePath, exportedName: "makeGetters" }, dir);
    expect(result.ok).toBe(true);
  }, 60_000);

  it("carries a code literal in the splice expression through unharmed", () => {
    // The splice expression is printed back to source, and a code literal
    // is the likeliest thing to survive that badly.
    const modulePath = write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(piece: Code): Code {\n  return piece\n}\n`,
    );
    const splice = spliceIn(`import { g } from "./gen.agency"\n\n$( g([| 42 |]) )\n`);
    const result = runGenerator(splice, { modulePath, exportedName: "g" }, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).toContain("42");
  }, 60_000);

  it("reports a generator that blows up at runtime as AG8008", () => {
    // The runtime turns an exception inside an Agency function into a
    // Failure Result, so this is what "the generator threw" looks like
    // from here. Its message has to survive into the diagnostic.
    const { splice, generator } = generatorReturning(
      `  const x = notDefinedAnywhere(1)\n  return [| 1 |]`,
    );
    const result = runGenerator(splice, generator, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceGeneratorFailed");
    expect(result.diagnostic.params.reason).toContain("notDefinedAnywhere");
  }, 60_000);

  it("reports a generator that returns a failure", () => {
    const { splice, generator } = generatorReturning(`  return failure("no data to work from")`);
    const result = runGenerator(splice, generator, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.params.reason).toContain("no data to work from");
  }, 60_000);

  it("reports a generator that never finishes", () => {
    const { splice, generator } = generatorReturning(
      `  while (true) {\n    let x = 1\n  }\n  return [| 1 |]`,
    );
    // A short limit on purpose. What could break is the signal handling,
    // not the number.
    const result = runGenerator(splice, generator, dir, { wallClockMs: 3_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceGeneratorFailed");
    expect(result.diagnostic.params.reason).toContain("did not finish");
  }, 60_000);

  it("reports a generator that exhausts memory", () => {
    const { splice, generator } = generatorReturning(
      `  let arr = []\n  while (true) {\n    arr.push([1, 2, 3, 4, 5, 6, 7, 8])\n  }\n  return [| 1 |]`,
    );
    const result = runGenerator(splice, generator, dir, {
      memoryMb: 64,
      wallClockMs: 30_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceGeneratorFailed");
    // Either limit is fine. The point is that an unbounded generator
    // becomes a diagnostic rather than a hung compiler.
    expect(result.diagnostic.params.reason).toMatch(/memory limit|did not finish/);
  }, 60_000);

  it("refuses a generator that returns something other than Code", () => {
    const modulePath = write("gen.agency", `export def g(): number {\n  return 3\n}\n`);
    const splice = spliceIn(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    const result = runGenerator(splice, { modulePath, exportedName: "g" }, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.params.reason).toContain("rather than a Code value");
  }, 60_000);

  it("refuses an object shaped like Code whose nodes field is not an array", () => {
    // What the Array.isArray half of isCode exists for: a value with the
    // right `type` tag that would crash the walker later.
    const modulePath = write(
      "gen.agency",
      `export def g(): any {\n  return { type: "agencyProgram", nodes: "not an array" }\n}\n`,
    );
    const splice = spliceIn(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    const result = runGenerator(splice, { modulePath, exportedName: "g" }, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.params.reason).toContain("rather than a Code value");
  }, 60_000);

  it("reports an unhandled interrupt rather than a shapeless failure", () => {
    // The backstop behind the static effect check. Compilation installs no
    // handlers, so a dangerous operation cannot complete.
    const modulePath = write(
      "gen.agency",
      `import { Code } from "std::agency"\nimport { read } from "std::file"\n\nexport def g(): Code {\n  const contents = read("nope.txt")\n  return [| 1 |]\n}\n`,
    );
    const splice = spliceIn(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    const result = runGenerator(splice, { modulePath, exportedName: "g" }, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceGeneratorFailed");
  }, 60_000);
});

describe("the child's environment", () => {
  it("does not hand the generator the parent's secrets", () => {
    // Whatever a generator reads can end up written into the code it
    // produces, and that code becomes a committed file.
    process.env.SPLICE_TEST_FAKE_SECRET = "sk-do-not-leak";
    try {
      const modulePath = write(
        "gen.agency",
        `import { Code, fill } from "std::agency"\nimport { env } from "std::system"\n\nexport def g(): Code {\n  const secret = env("SPLICE_TEST_FAKE_SECRET")\n  const filled = fill([| #v: string |], { v: secret })\n  if (isFailure(filled)) {\n    return [| "fill failed" |]\n  }\n  return filled.value\n}\n`,
      );
      const splice = spliceIn(`import { g } from "./gen.agency"\n\n$( g() )\n`);
      const result = runGenerator(splice, { modulePath, exportedName: "g" }, dir);
      expect(JSON.stringify(result)).not.toContain("sk-do-not-leak");
    } finally {
      delete process.env.SPLICE_TEST_FAKE_SECRET;
    }
  }, 60_000);

  it("still gives the child enough to run", () => {
    const { splice, generator } = generatorReturning(`  return [| 1 |]`);
    expect(runGenerator(splice, generator, dir).ok).toBe(true);
  }, 60_000);
});

describe("checkNoNestedSplice", () => {
  it("allows a generator with no splice anywhere in its closure", () => {
    write("helper.agency", `export def h(): number {\n  return 2\n}\n`);
    const generator = write(
      "gen.agency",
      `import { h } from "./helper.agency"\n\nexport def g(): number {\n  return h()\n}\n`,
    );
    expect(checkNoNestedSplice(generator, "g")).toBeNull();
  });

  it("refuses a generator module that itself contains a splice", () => {
    write("inner.agency", `export def i(): number {\n  return 1\n}\n`);
    const generator = write(
      "gen.agency",
      `import { i } from "./inner.agency"\n\nexport def g(): number {\n  return $( i() )\n}\n`,
    );
    const found = checkNoNestedSplice(generator, "g");
    expect(found?.diagnostic).toBe("spliceNested");
  });

  it("looks only at the generator's own file", () => {
    // The rule exists to stop runaway recursion, and one level does that.
    // A file one import away gets the same check when it is itself used as
    // a generator, so scanning the whole closure bought nothing.
    write("inner.agency", `export def i(): number {\n  return 1\n}\n`);
    write(
      "helper.agency",
      `import { i } from "./inner.agency"\n\nexport def h(): number {\n  return $( i() )\n}\n`,
    );
    const generator = write(
      "gen.agency",
      `import { h } from "./helper.agency"\n\nexport def g(): number {\n  return h()\n}\n`,
    );
    expect(checkNoNestedSplice(generator, "g")).toBeNull();
  });
});
