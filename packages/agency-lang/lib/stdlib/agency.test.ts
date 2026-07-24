import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _compileFile,
  _describe,
  _parseAST,
  _writeAST,
  _format,
  _formatFile,
  _walkAST,
  _getNodesOfType,
  _filterImports,
} from "./agency.js";
import type { AgencyNode } from "../types.js";
import type { ImportStatement } from "../types/importStatement.js";

// Sentinel string baked into the inside-the-sandbox source. The compiled JS
// has to contain it — that's what proves _compileFile actually read THIS
// file (and not, say, accidentally read outside.agency because the
// containment check was broken open).
const INSIDE_SENTINEL = "sentinel_inside_payload_xyz";

describe("_compileFile sandbox containment", () => {
  let sandbox: string;
  let outsideFile: string;
  // Sibling directory whose path shares a prefix with `sandbox`. Used to
  // attack the `+ sep` defense — without the trailing separator,
  // "/tmp/sandbox-abc".startsWith("/tmp/sandbox-ab") would be true.
  let siblingDir: string;
  let siblingFile: string;

  beforeAll(() => {
    // Layout:
    //   <tmp>/
    //     sandbox-XXXX/
    //       inside.agency      <- legal target
    //     sandbox-XXXX-evil/   <- shares string prefix with sandbox
    //       sneaky.agency      <- sibling-prefix attack target
    //     outside.agency        <- target the sandbox must NOT reach
    sandbox = mkdtempSync(join(tmpdir(), "agency-sandbox-"));
    writeFileSync(
      join(sandbox, "inside.agency"),
      `node main() { return "${INSIDE_SENTINEL}" }`,
      "utf-8",
    );
    outsideFile = join(sandbox, "..", "outside.agency");
    writeFileSync(
      outsideFile,
      `node main() { return "should not be reachable" }`,
      "utf-8",
    );
    siblingDir = `${sandbox}-evil`;
    mkdirSync(siblingDir);
    siblingFile = join(siblingDir, "sneaky.agency");
    writeFileSync(
      siblingFile,
      `node main() { return "should not be reachable" }`,
      "utf-8",
    );
  });

  afterAll(() => {
    try { rmSync(sandbox, { recursive: true }); } catch (_) { /* best effort */ }
    try { rmSync(outsideFile); } catch (_) { /* best effort */ }
    try { rmSync(siblingDir, { recursive: true }); } catch (_) { /* best effort */ }
  });

  it("compiles a file that lives inside the sandbox dir, and produces JS derived from THAT file", () => {
    const result = _compileFile(sandbox, "inside.agency");
    expect(result.moduleId).toBeTruthy();
    // Crucial: prove the compiled output came from inside.agency and not,
    // e.g., outside.agency. The sentinel string from inside.agency must
    // appear in the emitted JS (carried in the value, not written to disk).
    expect(result.code).toContain(INSIDE_SENTINEL);
  });

  it("rejects a filename containing .. that escapes the sandbox", () => {
    expect(() => _compileFile(sandbox, "../outside.agency")).toThrowError(
      /Sandbox violation/,
    );
  });

  it("rejects an absolute filename outside the sandbox", () => {
    expect(() => _compileFile(sandbox, outsideFile)).toThrowError(
      /Sandbox violation/,
    );
  });

  it("rejects a sibling directory whose path shares a prefix with the sandbox", () => {
    // Without the trailing `+ sep` on the prefix check, this would slip
    // through: "/tmp/sandbox-abc-evil/sneaky.agency" startsWith
    // "/tmp/sandbox-abc" is true. The `+ sep` is what makes this fail.
    expect(() =>
      _compileFile(sandbox, join("..", `${sandbox.split("/").pop()}-evil`, "sneaky.agency")),
    ).toThrowError(/Sandbox violation/);
  });

  it("rejects a symlink that points outside the sandbox", (ctx) => {
    // Create a symlink inside the sandbox that points to a file outside.
    // realpath on the symlink should resolve to the outside path, which
    // then fails the startsWith check.
    const link = join(sandbox, "evil.agency");
    try {
      symlinkSync(outsideFile, link);
    } catch (_) {
      // Symlink creation may fail on some CI environments / restricted
      // filesystems / Windows. Skip rather than silently pass — a real
      // regression in the symlink defense should be visible.
      ctx.skip();
      return;
    }
    expect(() => _compileFile(sandbox, "evil.agency")).toThrowError(
      /Sandbox violation/,
    );
  });

  it("calls compileSource with stdlib-only import policy (subprocess code can't import 'fs')", () => {
    // If _compileFile ever stops passing the stdlib-only import policy,
    // this test catches it. We write an inside-the-sandbox file that
    // imports 'fs' and assert _compileFile rejects it.
    writeFileSync(
      join(sandbox, "imports-fs.agency"),
      `import { readFileSync } from "fs"\nnode main() { return "x" }`,
      "utf-8",
    );
    expect(() => _compileFile(sandbox, "imports-fs.agency")).toThrowError(
      /Import 'fs' is not allowed/,
    );
  });
});

// ---------------------------------------------------------------------------
// _parseAST
// ---------------------------------------------------------------------------
describe("_parseAST", () => {
  it("returns an AgencyProgram with parsed nodes", () => {
    const ast = _parseAST("node main() { return 1 }");
    expect(ast.type).toBe("agencyProgram");
    expect(Array.isArray(ast.nodes)).toBe(true);
    const graphNode = ast.nodes.find((n) => n.type === "graphNode");
    expect(graphNode).toBeDefined();
    expect((graphNode as { nodeName: string }).nodeName).toBe("main");
  });

  it("throws on invalid source", () => {
    expect(() => _parseAST(")))")).toThrowError();
  });

  it("returns a JSON-serializable AST (deep-equal after stringify/parse)", () => {
    const ast = _parseAST("node main() { return 42 }");
    const roundtripped = JSON.parse(JSON.stringify(ast));
    expect(roundtripped).toEqual(ast);
  });

  it("does NOT lower patterns (so the AST round-trips through writeAST)", () => {
    // If `lower: true` were used, patterns would be desugared and the AST
    // would no longer round-trip back to the original source via the
    // formatter. We assert that fact indirectly by parsing+formatting and
    // checking the result is byte-identical to the formatted input (i.e.
    // the format function is idempotent — a property only the lower:false
    // / applyTemplate:false combo preserves).
    const src = `node main() { return 1 }`;
    const formatted = _format(src);
    expect(_format(formatted)).toBe(formatted);
  });
});

// ---------------------------------------------------------------------------
// _writeAST + _format + _formatFile
// ---------------------------------------------------------------------------
describe("_writeAST / _format / _formatFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-fmt-"));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
  });

  it("_format is idempotent on already-formatted source", () => {
    const formatted = _format(`node main() { return 1 }`);
    expect(_format(formatted)).toBe(formatted);
  });

  it("_format throws on parse failure", () => {
    expect(() => _format("def {")).toThrowError();
  });

  it("_format preserves single-line comments", () => {
    const formatted = _format(`// keep me\nnode main() { return 1 }`);
    expect(formatted).toContain("// keep me");
  });

  it("_format canonicalizes whitespace", () => {
    const ugly = `node    main(  ) {return    1}`;
    const formatted = _format(ugly);
    // Whatever the exact canonical form is, formatting should produce a
    // distinct shape from the ugly input.
    expect(formatted).not.toBe(ugly);
    // And re-formatting should be a no-op.
    expect(_format(formatted)).toBe(formatted);
  });

  it("_writeAST round-trips: parse → write → re-parse produces structurally equivalent AST", async () => {
    const src = `node main() { return 42 }`;
    const ast = _parseAST(src);
    await _writeAST(ast, dir, "out.agency", true);
    const reparsed = _parseAST(readFileSync(join(dir, "out.agency"), "utf-8"));
    // Compare structures modulo source locations — the formatter may add
    // a trailing newline / shift positions, but the semantic AST must
    // match.
    const stripLoc = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(stripLoc);
      if (x && typeof x === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
          if (k === "loc") continue;
          out[k] = stripLoc(v);
        }
        return out;
      }
      return x;
    };
    expect(stripLoc(reparsed)).toEqual(stripLoc(ast));
  });

  it("_writeAST with overwrite=true replaces an existing file", async () => {
    writeFileSync(join(dir, "out.agency"), `node old() { return 0 }`, "utf-8");
    const ast = _parseAST(`node fresh() { return 1 }`);
    await _writeAST(ast, dir, "out.agency", true);
    const written = readFileSync(join(dir, "out.agency"), "utf-8");
    expect(written).toContain("node fresh");
    expect(written).not.toContain("node old");
  });

  it("_writeAST with overwrite=false succeeds when file does not exist", async () => {
    const ast = _parseAST(`node main() { return 1 }`);
    await _writeAST(ast, dir, "new.agency", false);
    expect(existsSync(join(dir, "new.agency"))).toBe(true);
  });

  it("_writeAST with overwrite=false fails when the file already exists", async () => {
    writeFileSync(join(dir, "exists.agency"), `node x() {}`, "utf-8");
    const ast = _parseAST(`node main() { return 1 }`);
    await expect(_writeAST(ast, dir, "exists.agency", false)).rejects.toThrow(
      /already exists/,
    );
  });

  it("_writeAST allows upward traversal via .. segments", async () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const ast = _parseAST(`node main() { return 1 }`);
    // resolvePath no longer enforces containment; ".." resolves like
    // open() in other languages. Both dirs are inside this test's
    // mkdtemp sandbox.
    await _writeAST(ast, sub, "../upward.agency", true);
    expect(existsSync(join(dir, "upward.agency"))).toBe(true);
  });

  it("_writeAST allows absolute filenames (they win over dir)", async () => {
    const ast = _parseAST(`node main() { return 1 }`);
    const outPath = join(dir, "abs-out.agency");
    await _writeAST(ast, join(dir, "ignored-when-abs"), outPath, true);
    expect(existsSync(outPath)).toBe(true);
  });

  it("_formatFile formats a file in place", () => {
    const ugly = `node    main(  ) {return    1}`;
    writeFileSync(join(dir, "x.agency"), ugly, "utf-8");
    _formatFile(dir, "x.agency");
    const after = readFileSync(join(dir, "x.agency"), "utf-8");
    expect(after).not.toBe(ugly);
    expect(_format(after)).toBe(after);
  });

  it("_formatFile does NOT touch mtime when the file is already formatted", async () => {
    const src = _format(`node main() { return 1 }`);
    writeFileSync(join(dir, "x.agency"), src, "utf-8");
    const fs = await import("fs");
    const before = fs.statSync(join(dir, "x.agency")).mtimeMs;
    // Wait a moment so any actual write would yield a different mtime.
    await new Promise((r) => setTimeout(r, 20));
    _formatFile(dir, "x.agency");
    const after = fs.statSync(join(dir, "x.agency")).mtimeMs;
    expect(after).toBe(before);
  });

  it("_formatFile throws on missing file (mustExist:true sandbox)", () => {
    expect(() => _formatFile(dir, "missing.agency")).toThrowError();
  });

  it("_formatFile rejects path traversal", () => {
    // Create a file in the PARENT of the sandbox so `../outside.agency`
    // would resolve to an existing file. The realpath check must still
    // reject it because the resolved path lives outside `dir`.
    const outsidePath = join(dir, "..", "outside.agency");
    writeFileSync(outsidePath, `node x() {}`, "utf-8");
    try {
      expect(() => _formatFile(dir, "../outside.agency")).toThrowError(
        /Sandbox violation/,
      );
    } finally {
      try { rmSync(outsidePath); } catch (_) { /* best effort */ }
    }
  });
});

// ---------------------------------------------------------------------------
// _walkAST
// ---------------------------------------------------------------------------
describe("_walkAST", () => {
  it("returns a clone — original AST is not mutated", () => {
    const ast = _parseAST(`node main() { return 1 }`);
    const originalSnapshot = JSON.parse(JSON.stringify(ast));
    const { visits } = _walkAST(ast);
    for (const v of visits) {
      (v.node as { type: string }).type = "MUTATED";
    }
    expect(ast).toEqual(originalSnapshot);
  });

  it("clone IS mutated through the visits' references", () => {
    const ast = _parseAST(`node main() { return 1 }`);
    const { clone, visits } = _walkAST(ast);
    for (const v of visits) {
      (v.node as { type: string }).type = "MUTATED";
    }
    // Every node in clone should now read as MUTATED via the visit refs.
    expect(visits.every((v) => v.node.type === ("MUTATED" as never))).toBe(true);
    // And the clone's top-level nodes reflect the mutation.
    expect(clone.nodes.every((n) => n.type === ("MUTATED" as never))).toBe(true);
  });

  it("visits in pre-order: parent appears before its descendants", () => {
    const ast = _parseAST(`node main() { return 1 }`);
    const { visits } = _walkAST(ast);
    const types = visits.map((v) => v.node.type);
    const graphNodeIdx = types.indexOf("graphNode");
    const returnIdx = types.indexOf("returnStatement");
    expect(graphNodeIdx).toBeGreaterThanOrEqual(0);
    expect(returnIdx).toBeGreaterThan(graphNodeIdx);
  });

  it("ancestors are populated correctly: returnStatement's ancestors end with graphNode", () => {
    const ast = _parseAST(`node main() { return 1 }`);
    const { visits } = _walkAST(ast);
    const ret = visits.find((v) => v.node.type === "returnStatement");
    expect(ret).toBeDefined();
    const ancestorTypes = ret!.ancestors.map((a) => a.type);
    expect(ancestorTypes).toContain("graphNode");
  });

  it("mutating a parent does NOT affect the rest of the iteration (visits are buffered)", () => {
    const ast = _parseAST(`node main() { return 1 }`);
    const { visits } = _walkAST(ast);
    const originalCount = visits.length;
    // Clobbering the graphNode's body shouldn't shrink the visit list — it's
    // already been collected.
    const graphNode = visits.find((v) => v.node.type === "graphNode")!.node as {
      body: AgencyNode[];
    };
    graphNode.body = [];
    // We can still iterate every original visit without crashing.
    for (const v of visits) {
      expect(v.node).toBeDefined();
    }
    expect(visits.length).toBe(originalCount);
  });
});

// ---------------------------------------------------------------------------
// _getNodesOfType + convenience wrappers
// ---------------------------------------------------------------------------
describe("_getNodesOfType and convenience wrappers", () => {
  const fixture = `
import { foo } from "./bar.agency"
import { exists } from "std::shell"

def helper(): number {
  return 1
}

def other(): string {
  return "x"
}

node main() {
  return helper()
}

node aux() {
  return 1
}
`;

  it("_getNodesOfType with an empty types array returns []", () => {
    expect(_getNodesOfType(fixture, [])).toEqual([]);
  });

  it("_getNodesOfType walks deeply (functionCall lives inside a body)", () => {
    const calls = _getNodesOfType(fixture, ["functionCall"]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((n) => n.type === "functionCall")).toBe(true);
  });

  it("_getNodesOfType accepts multiple types in one call (union)", () => {
    const both = _getNodesOfType(fixture, ["function", "graphNode"]);
    const types = both.map((n) => n.type).sort();
    expect(types).toEqual(["function", "function", "graphNode", "graphNode"]);
  });

  it("_getNodesOfType returns [] for unknown type strings (no error)", () => {
    expect(_getNodesOfType(fixture, ["definitely-not-a-real-type"])).toEqual([]);
  });

  it("_getNodesOfType throws on parse failure", () => {
    expect(() => _getNodesOfType(")))", ["function"])).toThrowError();
  });

  // The Agency-level convenience wrappers (getImports / getFunctions /
  // getGraphNodes) are one-liners that call getNodesOfType with a single
  // type string. We exercise the underlying TS primitive here; the Agency
  // wrappers themselves live in stdlib/agency.agency.

  it("getNodesOfType(['importStatement']) returns all importStatement nodes", () => {
    const imports = _getNodesOfType(fixture, ["importStatement"]);
    expect(imports.length).toBe(2);
    const paths = imports
      .map((n) => (n as ImportStatement).modulePath)
      .sort();
    expect(paths).toEqual(["./bar.agency", "std::shell"]);
  });

  it("getNodesOfType(['function']) returns all function definitions", () => {
    const fns = _getNodesOfType(fixture, ["function"]);
    expect(fns.length).toBe(2);
    expect(fns.every((n) => n.type === "function")).toBe(true);
  });

  it("getNodesOfType(['graphNode']) returns all graph node definitions", () => {
    const nodes = _getNodesOfType(fixture, ["graphNode"]);
    expect(nodes.length).toBe(2);
    expect(nodes.every((n) => n.type === "graphNode")).toBe(true);
  });

  it("returns empty arrays for an empty source", () => {
    expect(_getNodesOfType("", ["importStatement"])).toEqual([]);
    expect(_getNodesOfType("", ["function"])).toEqual([]);
    expect(_getNodesOfType("", ["graphNode"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _filterImports
// ---------------------------------------------------------------------------
describe("_filterImports", () => {
  const fixture = `import { foo } from "./bar.agency"
import { exists } from "std::shell"
import { thing } from "pkg::wikipedia"
import * as fs from "fs"

node main() { return 1 }`;

  it("all four lists empty → no filtering, filtered=false", () => {
    const result = _filterImports(fixture, [], [], [], []);
    expect(result.filtered).toBe(false);
    // Source should be the formatted version of the original.
    expect(result.source).toBe(_format(fixture));
  });

  it("allowKinds=['stdlib'] keeps only stdlib imports", () => {
    const result = _filterImports(fixture, [], [], ["stdlib"], []);
    expect(result.filtered).toBe(true);
    expect(result.source).toContain("std::shell");
    expect(result.source).not.toContain("./bar.agency");
    expect(result.source).not.toContain("pkg::wikipedia");
    expect(result.source).not.toContain('"fs"');
  });

  it("excludeKinds=['node'] drops bare-specifier imports only", () => {
    const result = _filterImports(fixture, [], [], [], ["node"]);
    expect(result.filtered).toBe(true);
    expect(result.source).not.toContain('"fs"');
    expect(result.source).toContain("./bar.agency");
    expect(result.source).toContain("std::shell");
    expect(result.source).toContain("pkg::wikipedia");
  });

  it("allowedPackages exact-list passes only matching imports", () => {
    const result = _filterImports(
      fixture,
      ["std::shell", "pkg::wikipedia"],
      [],
      [],
      [],
    );
    expect(result.filtered).toBe(true);
    expect(result.source).toContain("std::shell");
    expect(result.source).toContain("pkg::wikipedia");
    expect(result.source).not.toContain("./bar.agency");
    expect(result.source).not.toContain('"fs"');
  });

  it("exclude wins over allow: excludedPackages=['std::shell'] + allowKinds=['stdlib']", () => {
    const src = `import { exists } from "std::shell"
import { print } from "std::index"

node main() { return 1 }`;
    const result = _filterImports(src, [], ["std::shell"], ["stdlib"], []);
    expect(result.filtered).toBe(true);
    expect(result.source).not.toContain("std::shell");
    expect(result.source).toContain("std::index");
  });

  it("union semantics: allowKinds + allowedPackages both pass", () => {
    const result = _filterImports(
      fixture,
      ["pkg::wikipedia"],
      [],
      ["stdlib"],
      [],
    );
    expect(result.filtered).toBe(true);
    expect(result.source).toContain("std::shell");
    expect(result.source).toContain("pkg::wikipedia");
    expect(result.source).not.toContain("./bar.agency");
    expect(result.source).not.toContain('"fs"');
  });

  it("unknown kind in allowKinds is inert (matches nothing) — non-empty allow still gates", () => {
    // allowKinds=['bogus'] + everything else empty = no allow rule matches
    // anything → everything fails the allow check → all imports dropped.
    const result = _filterImports(fixture, [], [], ["bogus"], []);
    expect(result.filtered).toBe(true);
    expect(result.source).not.toContain("std::shell");
    expect(result.source).not.toContain("./bar.agency");
    expect(result.source).not.toContain("pkg::wikipedia");
    expect(result.source).not.toContain('"fs"');
  });

  it("glob: allowedPackages=['std::*'] passes all stdlib imports", () => {
    const result = _filterImports(fixture, ["std::*"], [], [], []);
    expect(result.filtered).toBe(true);
    expect(result.source).toContain("std::shell");
    expect(result.source).not.toContain("pkg::wikipedia");
    expect(result.source).not.toContain("./bar.agency");
    expect(result.source).not.toContain('"fs"');
  });

  it("empty source / no imports → filtered=false, byte-equal to format()", () => {
    const src = `node main() { return 1 }`;
    const result = _filterImports(src, [], [], ["stdlib"], []);
    expect(result.filtered).toBe(false);
    expect(result.source).toBe(_format(src));
  });
});

describe("_describe (reify)", () => {
  const source = [
    "/** @module",
    "  @summary Tools for the news agent.",
    "*/",
    "",
    "/** Fetches one article. */",
    "export idempotent def fetchArticle(url: string): string {",
    "  \"\"\"",
    "  Fetch one article body by URL.",
    "  \"\"\"",
    "  return \"body\"",
    "}",
    "",
    "export destructive def saveNote(text: string) {",
    "  write(\"notes.txt\", text)",
    "}",
    "",
    "def helper(): number {",
    "  return 1",
    "}",
    "",
    "export def _plumbing(): number {",
    "  return 2",
    "}",
    "",
    "/** One extracted article. */",
    "export type Article = {",
    "  title: string,",
    "  words: number",
    "}",
    "",
    "export node main(): string {",
    "  return fetchArticle(\"x\")",
    "}",
    "",
  ].join("\n");

  it("lists exported defs, nodes, and types in source order, skipping non-exports and underscore plumbing", () => {
    const info = _describe(source);
    expect(info.exports.map((e) => [e.name, e.kind])).toEqual([
      ["fetchArticle", "def"],
      ["saveNote", "def"],
      ["Article", "type"],
      ["main", "node"],
    ]);
  });

  it("carries signatures, docstrings, and tool markers", () => {
    const info = _describe(source);
    const fetch = info.exports.find((e) => e.name === "fetchArticle");
    expect(fetch?.signature).toContain("fetchArticle(url: string): string");
    expect(fetch?.signature).not.toContain("export");
    expect(fetch?.docstring).toContain("Fetch one article body");
    expect(fetch?.idempotent).toBe(true);
    expect(fetch?.destructive).toBe(false);
    const save = info.exports.find((e) => e.name === "saveNote");
    expect(save?.destructive).toBe(true);
    expect(save?.docstring).toBe(null);
  });

  it("reports transitive effects with the same names getEffects uses", () => {
    const info = _describe(source);
    const save = info.exports.find((e) => e.name === "saveNote");
    expect(save?.effects).toEqual(["std::write"]);
    const article = info.exports.find((e) => e.name === "Article");
    expect(article?.effects).toEqual([]);
  });

  it("prints a type alias signature without the export keyword", () => {
    const info = _describe(source);
    const article = info.exports.find((e) => e.name === "Article");
    expect(article?.signature).toMatch(/^type Article = \{/);
    expect(article?.signature).toContain("title: string");
    expect(article?.docstring).toContain("One extracted article");
  });

  it("surfaces the module doc comment as the description", () => {
    const info = _describe(source);
    expect(info.description).toContain("Tools for the news agent");
  });

  it("returns no description and no exports for a bare program", () => {
    const info = _describe("node main() {\n  return 1\n}\n");
    expect(info).toEqual({ description: null, exports: [] });
  });
});

describe("_describe (reify): re-exports, consts, module summary", () => {
  it("resolves std:: re-exports to real entries with reexportedFrom", () => {
    const info = _describe('export { map, filter as keep } from "std::index"\n');
    expect(info.exports.map((e) => [e.name, e.kind, e.reexportedFrom])).toEqual([
      ["map", "def", "std::index"],
      ["keep", "def", "std::index"],
    ]);
    expect(info.exports[0].signature).toContain("map(");
  });

  it("star re-exports from std:: enumerate the source module, outermost path winning", () => {
    // std::array is nothing but a re-export block over std::index — the
    // module shape that motivated re-export support (it used to describe
    // as an empty surface).
    const info = _describe('export * from "std::array"\n');
    expect(info.exports.length).toBeGreaterThan(3);
    expect(info.exports.every((e) => e.reexportedFrom === "std::array")).toBe(true);
    expect(info.exports.some((e) => e.name === "map" && e.kind === "def")).toBe(true);
  });

  it("unresolvable re-exports come back thin with the unknown sentinel, markers applied", () => {
    const info = _describe(
      'export { helper, destructive rmrf } from "./local.agency"\n',
    );
    expect(info.exports.map((e) => [e.name, e.kind])).toEqual([
      ["helper", "reexport"],
      ["rmrf", "reexport"],
    ]);
    expect(info.exports[0].effects).toEqual(["unknown"]);
    expect(info.exports[0].reexportedFrom).toBe("./local.agency");
    expect(info.exports[1].destructive).toBe(true);
  });

  it("exported consts are surface, one entry per bound name", () => {
    const src = [
      'export const version: string = "1.0"',
      "",
      "def pair(): { a: number, b: number } {",
      "  return { a: 1, b: 2 }",
      "}",
      "",
      "export const { a, b } = pair()",
      "",
      "node main() {",
      "  return version",
      "}",
      "",
    ].join("\n");
    const info = _describe(src);
    const consts = info.exports.filter((e) => e.kind === "const");
    expect(consts.map((e) => e.name)).toEqual(["version", "a", "b"]);
    expect(consts[0].signature).toBe("const version: string");
    expect(consts[1].signature).toBe("const a");
  });

  it("description is the summary line only, never glued to the body prose", () => {
    const src = [
      "/** @module",
      "@summary News tools.",
      "Longer prose about the news tools that must not be glued on.",
      "*/",
      "",
      "node main() {",
      "  return 1",
      "}",
      "",
    ].join("\n");
    expect(_describe(src).description).toBe("News tools.");
  });
});
