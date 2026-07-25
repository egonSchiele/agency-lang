import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { safeDeleteDirectory } from "../utils.js";
import { parseAgency } from "../parser.js";
import { walkNodesArray } from "../utils/node.js";
import { clearSpliceCache } from "../compiler/splice/cache.js";
import { expandSplices } from "./expandSplices.js";
import type { AgencyProgram } from "../types.js";

let dir: string;

beforeEach(() => {
  dir = path.join(process.cwd(), ".agency-tmp", `splice-expand-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
  clearSpliceCache();
});

afterEach(() => {
  safeDeleteDirectory(dir, false);
  clearSpliceCache();
});

function write(name: string, source: string): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, source, "utf-8");
  return target;
}

function parse(source: string): AgencyProgram {
  const result = parseAgency(source, {}, false, false);
  if (!result.success) {
    throw new Error(result.message ?? "parse failed");
  }
  return result.result;
}

/** Parse `source` as the host file and expand it. */
function expand(source: string) {
  const hostPath = write("host.agency", source);
  return expandSplices(parse(source), hostPath, {});
}

/** A generator module returning a program fragment declaring `greet`. */
function writeDeclGenerator(): void {
  write(
    "gen.agency",
    `import { Code } from "std::agency"\n\nexport def makeGreet(): Code {\n  return [|\n    def greet(): string {\n      return "hi"\n    }\n  |]\n}\n`,
  );
}

/** A generator module returning a single expression. */
function writeExprGenerator(): void {
  write(
    "gen.agency",
    `import { Code } from "std::agency"\n\nexport def two(): Code {\n  return [| 2 |]\n}\n`,
  );
}

describe("expandSplices", () => {
  it("returns a program with no splices unchanged, identically", () => {
    const program = parse(`def f(): number {\n  return 1\n}\n`);
    const result = expandSplices(program, write("host.agency", "x"), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Identity, not equality: a file without splices must pay nothing.
    expect(result.value).toBe(program);
  });

  it("replaces a declaration splice with the generator's declarations", () => {
    writeDeclGenerator();
    const result = expand(
      `import { makeGreet } from "./gen.agency"\n\n$( makeGreet() )\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.nodes
      .filter((node) => node.type === "function")
      .map((node) => (node as { functionName: string }).functionName);
    expect(names).toContain("greet");
    expect(result.value.nodes.some((node) => node.type === "splice")).toBe(false);
  }, 60_000);

  it("replaces an expression splice with one expression", () => {
    writeExprGenerator();
    const result = expand(
      `import { two } from "./gen.agency"\n\ndef f(): number {\n  return $( two() )\n}\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const remaining = [...walkNodesArray(result.value.nodes)].filter(
      (visit) => visit.node.type === "splice",
    );
    expect(remaining).toHaveLength(0);
    expect(JSON.stringify(result.value)).toContain('"value":"2"');
  }, 60_000);

  it("expands two splices in one file", () => {
    // A declaration splice spreads N nodes and shifts the index of every
    // splice after it, which is exactly where index-based grafting breaks.
    writeDeclGenerator();
    write(
      "gen2.agency",
      `import { Code } from "std::agency"\n\nexport def makeBye(): Code {\n  return [|\n    def bye(): string {\n      return "bye"\n    }\n  |]\n}\n`,
    );
    const result = expand(
      `import { makeGreet } from "./gen.agency"\nimport { makeBye } from "./gen2.agency"\n\n$( makeGreet() )\n\n$( makeBye() )\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.nodes
      .filter((node) => node.type === "function")
      .map((node) => (node as { functionName: string }).functionName);
    expect(names).toContain("greet");
    expect(names).toContain("bye");
  }, 60_000);

  it("refuses a program fragment in expression position", () => {
    writeDeclGenerator();
    const result = expand(
      `import { makeGreet } from "./gen.agency"\n\ndef f(): number {\n  return $( makeGreet() )\n}\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceFragmentKindMismatch");
  }, 60_000);

  it("refuses an argument that names something the host file declares", () => {
    writeExprGenerator();
    const result = expand(
      `import { two } from "./gen.agency"\n\nconst limit = 5\n\ndef f(): number {\n  return $( two(limit) )\n}\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceArgumentNotAvailable");
    expect(result.diagnostic.params.name).toBe("limit");
  });

  it("allows literal and code-literal arguments", () => {
    // Without this, an over-strict implementation rejects every useful
    // splice and still passes the test above.
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def pick(n: number, piece: Code): Code {\n  if (n > 0) {\n    return piece\n  }\n  return [| 0 |]\n}\n`,
    );
    const result = expand(
      `import { pick } from "./gen.agency"\n\ndef f(): number {\n  return $( pick(1, [| 7 |]) )\n}\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).toContain('"value":"7"');
  }, 60_000);

  it("refuses a generator that is not imported", () => {
    const result = expand(
      `def gen(): number {\n  return 1\n}\n\ndef f(): number {\n  return $( gen() )\n}\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceGeneratorNotImported");
  });

  it("leaves a splice inside a code literal alone", () => {
    // The literal's body belongs to the program being generated, so a
    // splice in there is that program's business, not this one's.
    const source = `import { Code } from "std::agency"\n\nexport def wrap(): Code {\n  return [|\n    def f(): number {\n      return $( inner() )\n    }\n  |]\n}\n`;
    const program = parse(source);
    const result = expandSplices(program, write("host.agency", source), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(program);
  });

  it("stamps loc.origin on grafted nodes", () => {
    // The feature's distinguishing claim over toSource + runCode: an error
    // inside generated code can still say where the code came from.
    writeDeclGenerator();
    const result = expand(
      `import { makeGreet } from "./gen.agency"\n\n$( makeGreet() )\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grafted = result.value.nodes.find(
      (node) => node.type === "function",
    ) as { loc?: { origin?: { kind: string; name: string } } };
    expect(grafted.loc?.origin).toEqual({ kind: "splice", name: "makeGreet" });
  }, 60_000);

  it("refuses a generator that reaches non-Agency code", () => {
    write("side.agency", `import { z } from "zod"\n\nexport def s(): number {\n  return 1\n}\n`);
    write(
      "gen.agency",
      `import { Code } from "std::agency"\nimport { s } from "./side.agency"\n\nexport def g(): Code {\n  return [| 1 |]\n}\n`,
    );
    const result = expand(
      `import { g } from "./gen.agency"\n\ndef f(): number {\n  return $( g() )\n}\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceGeneratorReachesNonAgency");
  });

  it("refuses a generator whose closure reaches back to the splicing file", () => {
    // The cycle case. Running this generator would compile it, which
    // builds a symbol table, which walks to host.agency, which has a
    // splice — the loop the in-progress guard exists to stop. It is caught
    // earlier and more cleanly here, by the nested-splice check, before
    // anything is compiled at all.
    const source = `import { g } from "./gen.agency"\n\nconst seed = 1\n\ndef f(): number {\n  return $( g() )\n}\n`;
    const hostPath = write("host.agency", source);
    write(
      "gen.agency",
      `import { Code } from "std::agency"\nimport { f } from "./host.agency"\n\nexport def g(): Code {\n  return [| 1 |]\n}\n`,
    );
    const result = expandSplices(parse(source), hostPath, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceNested");
  });

  it("anchors the diagnostic at the splice", () => {
    writeExprGenerator();
    const result = expand(
      `import { two } from "./gen.agency"\n\nconst limit = 5\n\ndef f(): number {\n  return $( two(limit) )\n}\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.loc.line).toBeGreaterThan(1);
  });
});
