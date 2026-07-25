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

  it("refuses generated code that reads a name from the splice site", () => {
    // The capture case, and the reason the rule exists. `tmp` here is the
    // generator author's guess at a name; pasted into a body that has its
    // own `tmp`, it would silently read the local one.
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [| tmp |]\n}\n`,
    );
    const result = expand(
      `import { g } from "./gen.agency"\n\ndef f(): number {\n  const tmp = 1\n  return $( g() )\n}\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceReferencesOuterName");
    expect(result.diagnostic.params.name).toBe("tmp");
  }, 60_000);

  it("allows generated code that references a name it declares itself", () => {
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    def helper(): number {\n      return 1\n    }\n\n    def caller(): number {\n      return helper()\n    }\n  |]\n}\n`,
    );
    const result = expand(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    expect(result.ok).toBe(true);
  }, 60_000);

  it("allows generated code that imports what it uses", () => {
    write("dep.agency", `export def dep(): number {\n  return 1\n}\n`);
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    import { dep } from "./dep.agency"\n\n    def uses(): number {\n      return dep()\n    }\n  |]\n}\n`,
    );
    const result = expand(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    expect(result.ok).toBe(true);
  }, 60_000);

  it("allows generated code that calls a builtin", () => {
    // Do not drop this. Without it, an over-strict implementation passes
    // every other case here while rejecting every generator anyone would
    // actually write.
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    def shout(): string {\n      print("hi")\n      return "hi"\n    }\n  |]\n}\n`,
    );
    const result = expand(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    expect(result.ok).toBe(true);
  }, 60_000);

  it("refuses generated code leaning on an import the HOST made", () => {
    // The subtle inverse of the case above: an implementation checking
    // against the wrong import list gets this backwards and allows it.
    write("dep.agency", `export def dep(): number {\n  return 1\n}\n`);
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    def uses(): number {\n      return dep()\n    }\n  |]\n}\n`,
    );
    const result = expand(
      `import { g } from "./gen.agency"\nimport { dep } from "./dep.agency"\n\n$( g() )\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceReferencesOuterName");
    expect(result.diagnostic.params.name).toBe("dep");
  }, 60_000);

  it("refuses a generated declaration that redeclares a host name", () => {
    // The design assumed a collision here would be caught by Agency's own
    // duplicate-declaration error. Measured: true for `def`, FALSE for
    // top-level `const`, where the later one silently wins. So the rule is
    // enforced rather than assumed.
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    const config = "generated"\n  |]\n}\n`,
    );
    const result = expand(
      `import { g } from "./gen.agency"\n\nconst config = "hand written"\n\n$( g() )\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceRedeclaresHostName");
    expect(result.diagnostic.params.declared).toBe("config");
  }, 60_000);

  it("refuses two splices generating the same name", () => {
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    def dup(): number {\n      return 1\n    }\n  |]\n}\n`,
    );
    const result = expand(
      `import { g } from "./gen.agency"\n\n$( g() )\n\n$( g() )\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceRedeclaresHostName");
  }, 60_000);

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
