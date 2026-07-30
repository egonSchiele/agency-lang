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
    // A declaration splice spreads N nodes and shifts every index after
    // it, which is where index-based grafting breaks.
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
    // The literal's body belongs to the program being generated, so its
    // splices are that program's business.
    const source = `import { Code } from "std::agency"\n\nexport def wrap(): Code {\n  return [|\n    def f(): number {\n      return $( inner() )\n    }\n  |]\n}\n`;
    const program = parse(source);
    const result = expandSplices(program, write("host.agency", source), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(program);
  });

  it("stamps loc.origin on grafted nodes", () => {
    // What toSource plus runCode cannot do: an error inside generated code
    // still says where it came from.
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

  it("refuses generated code that reads a name from the splice site", () => {
    // Pasted into a body with its own `tmp`, this would silently read the
    // local one.
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
    // Do not drop this. Without it an over-strict implementation passes
    // every other case here while rejecting every real generator.
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    def shout(): string {\n      print("hi")\n      return "hi"\n    }\n  |]\n}\n`,
    );
    const result = expand(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    expect(result.ok).toBe(true);
  }, 60_000);

  it("refuses generated code leaning on an import the HOST made", () => {
    // The inverse of the case above. Checking the wrong import list gets
    // this backwards and allows it.
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

  it("refuses a generated declaration marked export", () => {
    // Other files learn what a module exports by reading its source, so an
    // exported generated name would only resolve for callers willing to
    // run the generator. Tracked as #687.
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    export def shared(): string {\n      return "x"\n    }\n  |]\n}\n`,
    );
    const result = expand(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceGeneratedExport");
  }, 60_000);

  it("refuses a generated re-export, which carries no exported flag", () => {
    // `export def x` sets `exported: true`; `export { x } from "..."` is a
    // different node type with no such flag. Checking the flag alone let
    // this through.
    write("other.agency", `export def x(): number {\n  return 1\n}\n`);
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    export { x } from "./other.agency"\n  |]\n}\n`,
    );
    const result = expand(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceGeneratedExport");
  }, 60_000);

  it("refuses a generated declaration that redeclares a host name", () => {
    // Agency catches this for `def` but not for top-level `const`, where
    // the later one silently wins. So the rule is enforced here.
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

  it("refuses an argument naming a local at the splice site", () => {
    // `size` is not a top-level declaration, so a blocklist keyed on the
    // file's own declarations lets this through and the user gets a
    // ReferenceError from a program they never wrote.
    writeExprGenerator();
    const result = expand(
      `import { two } from "./gen.agency"\n\ndef f(): number {\n  const size = 3\n  return $( two(size) )\n}\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceArgumentNotAvailable");
    expect(result.diagnostic.params.name).toBe("size");
  });

  it("allows a builtin as an argument", () => {
    // Builtins come from the language, not the file, so they exist before
    // it does. Refusing them made `$( gen(__dirname) )` fail with a
    // message saying __dirname was declared in this file.
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def here(d: string): Code {\n  return [| 1 |]\n}\n`,
    );
    const result = expand(
      `import { here } from "./gen.agency"\n\ndef f(): number {\n  return $( here(__dirname) )\n}\n`,
    );
    expect(result.ok).toBe(true);
  }, 60_000);

  it("allows an argument naming something the host imported", () => {
    write("data.agency", `export static const LIMIT = 4\n`);
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def sized(n: number): Code {\n  return [| 1 |]\n}\n`,
    );
    const result = expand(
      `import { sized } from "./gen.agency"\nimport { LIMIT } from "./data.agency"\n\ndef f(): number {\n  return $( sized(LIMIT) )\n}\n`,
    );
    expect(result.ok).toBe(true);
  }, 60_000);

  it("refuses a generated declaration that collides with an imported name", () => {
    write("helpers.agency", `export def greet(): string {\n  return "imported"\n}\n`);
    writeDeclGenerator();
    const result = expand(
      `import { makeGreet } from "./gen.agency"\nimport { greet } from "./helpers.agency"\n\n$( makeGreet() )\n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceRedeclaresHostName");
    expect(result.diagnostic.params.declared).toBe("greet");
  }, 60_000);

  it("refuses generator output that itself contains a splice", () => {
    // Splices are expressions, so a generator can return one. This pass
    // enumerates the host's splices once, so a generated splice would
    // survive to the codegen tripwire and surface as an internal error.
    write("inner.agency", `import { Code } from "std::agency"\n\nexport def i(): Code {\n  return [| 1 |]\n}\n`);
    write(
      "gen.agency",
      `import { Code, parseStatements } from "std::agency"\n\nexport def g(): Code {\n  const parsed = parseStatements("const x = $( i() )")\n  if (isFailure(parsed)) {\n    return [| 0 |]\n  }\n  return parsed.value\n}\n`,
    );
    const result = expand(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.diagnostic).toBe("spliceNested");
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

describe("a declaration splice is held to the top-level rule", () => {
  /** A generator whose fragment holds `body`, with the inferred kind left
   *  to kind inference — which is the point of several cases below. */
  function writeGenerator(body: string): void {
    write(
      "gen.agency",
      `import { Code } from "std::agency"\n\nexport def gen(): Code {\n  return [|\n${body}\n  |]\n}\n`,
    );
  }

  function spliceAtTopLevel() {
    return expand(`import { gen } from "./gen.agency"\n\n$( gen() )\n`);
  }

  it("accepts a statements fragment whose nodes are all legal", () => {
    writeGenerator("    const apiKey = 1");
    const result = spliceAtTopLevel();
    expect(result.ok).toBe(true);
  });

  it("refuses a statements fragment containing an if, naming it", () => {
    writeGenerator("    if (true) {\n      print(1)\n    }");
    const result = spliceAtTopLevel();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.diagnostic)).toMatch(/ifElse|if/);
  });

  it("refuses the mixed fragment, which is the case the rule exists for", () => {
    // One fragment, one legal statement and one illegal one. No fragment
    // KIND distinguishes these — only looking at each node does.
    writeGenerator("    const apiKey = 1\n    if (true) {\n      print(1)\n    }");
    const result = spliceAtTopLevel();
    expect(result.ok).toBe(false);
  });

  it("refuses a fragment containing a body-only block", () => {
    // A `guard` block cannot be parsed at the top level at all, so this
    // path is the only way one reaches the check.
    writeGenerator("    guard(maxTime: 100) {\n      print(1)\n    }");
    const result = spliceAtTopLevel();
    expect(result.ok).toBe(false);
  });

  it("refuses a program fragment containing an if", () => {
    // The hole a statements-only check leaves: this fragment infers kind
    // `program`, because the statements attempt fails on the `def`. It
    // passed the kind gate unexamined and crashed the backend.
    writeGenerator(
      "    if (true) {\n      print(1)\n    }\n\n    def helper(): number {\n      return 1\n    }",
    );
    const result = spliceAtTopLevel();
    expect(result.ok).toBe(false);
  });

  it("still accepts a program fragment whose declarations are legal", () => {
    writeGenerator('    def helper(): string {\n      return "hi"\n    }');
    const result = spliceAtTopLevel();
    expect(result.ok).toBe(true);
  });
});
