import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildCompiledClosure,
  CompileClosureError,
} from "./compileClosure.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "compile-closure-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, contents: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf-8");
  return abs;
}

describe("buildCompiledClosure", () => {
  it("parses every reachable file once and produces a per-module plan", () => {
    const fooPath = write(
      "foo.agency",
      'import { barStatic } from "./bar.agency"\n' +
        'static const fooStatic = barStatic + "!"\n' +
        'node main() { return fooStatic }\n',
    );
    write("bar.agency", 'export static const barStatic = "hello"\n');

    const c = buildCompiledClosure(fooPath, {});
    expect(Object.keys(c.programs).sort()).toEqual(
      [fooPath, path.join(dir, "bar.agency")].sort(),
    );
    expect(c.plans[fooPath]).toBeDefined();
    expect(c.plans[path.join(dir, "bar.agency")]).toBeDefined();
    expect(c.plans[fooPath]!.static.localOrder).toEqual(["fooStatic"]);
    expect(c.plans[fooPath]!.static.awaitModules).toEqual([
      path.join(dir, "bar.agency"),
    ]);
  });

  it("throws CompileClosureError on a static cycle, naming both decls", () => {
    const fooPath = write(
      "foo.agency",
      'import { barStatic } from "./bar.agency"\n' +
        'export static const fooStatic = barStatic + "!"\n',
    );
    write(
      "bar.agency",
      'import { fooStatic } from "./foo.agency"\n' +
        'export static const barStatic = fooStatic + "?"\n',
    );

    let err: unknown = null;
    try {
      buildCompiledClosure(fooPath, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CompileClosureError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/Circular static dependency/);
    expect(msg).toMatch(/fooStatic/);
    expect(msg).toMatch(/barStatic/);
  });

  it("throws CompileClosureError when a static initializer references a global", () => {
    const entryPath = write(
      "entry.agency",
      'const g = "hello"\n' +
        'static const s = g + "!"\n' +
        'node main() { return s }\n',
    );

    let err: unknown = null;
    try {
      buildCompiledClosure(entryPath, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CompileClosureError);
    // PR 4 reformatted the message: `static const 'name'` and
    // `global 'name'` (instead of generic "Static 'name'") so
    // the surface mirrors the source-level keyword.
    expect((err as Error).message).toMatch(
      /static const '?s'?.*references global '?g'?/,
    );
  });

  it("throws CompileClosureError when a file in the closure fails to parse", () => {
    const entryPath = write(
      "entry.agency",
      'import { x } from "./broken.agency"\n' +
        'static const s = x + "!"\n',
    );
    write(
      "broken.agency",
      'this is not (((( valid agency syntax\n',
    );

    let err: unknown = null;
    try {
      buildCompiledClosure(entryPath, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CompileClosureError);
    expect((err as Error).message).toMatch(/Failed to parse/);
  });

  it("threads re-export chains as one-hop awaits so wrapper statics init in cascade", () => {
    // foo imports barStatic from reexport.agency, which re-exports from
    // bar.agency. `resolveReExports` synthesizes a wrapper static
    // `static const barStatic = _reexport_barStatic` in reexport.agency
    // that needs its own `__initializeStatic` to run. The dep graph
    // resolves imports one hop at a time so foo awaits reexport (its
    // direct source), and reexport's own plan awaits bar — the runtime
    // cascade then walks the full chain automatically.
    const fooPath = write(
      "foo.agency",
      'import { barStatic } from "./reexport.agency"\n' +
        'static const fooStatic = barStatic + "!"\n' +
        'node main() { return fooStatic }\n',
    );
    const reexportPath = write(
      "reexport.agency",
      'export { barStatic } from "./bar.agency"\n',
    );
    const barPath = write(
      "bar.agency",
      'export static const barStatic = "hello"\n',
    );

    const c = buildCompiledClosure(fooPath, {});
    expect(c.plans[fooPath]!.static.awaitModules).toEqual([reexportPath]);
    expect(c.plans[reexportPath]!.static.awaitModules).toEqual([barPath]);
  });

  it("bare top-level stmts contribute cross-module awaits to the global plan", () => {
    // Regression: phasePlanFor used to drop edges out of synthetic
    // __bareStmt_ nodes entirely, so a bare call referencing an
    // imported global produced no `await __awaitGlobalsInit(helper, ...)`
    // — the bare body could run before the helper module's
    // __initializeGlobals had populated `helperGlobal`. We still keep
    // bare nodes out of `localOrder` (codegen emits them inline) but
    // we must follow their edges for the cross-module await.
    //
    // Uses a namespace import so the underlying bareStmt edge actually
    // makes it into the dep graph: named imports of non-static
    // globals aren't in the symbol table, so this is the only way to
    // get a cross-module global-to-global edge today (until that
    // resolver gap closes).
    const mainPath = write(
      "main.agency",
      'import * as helper from "./helper.agency"\n' +
        'def show(s: string) {}\n' +
        'show(helper.helperGlobal)\n' +
        'node main() { return "ok" }\n',
    );
    const helperPath = write(
      "helper.agency",
      'export const helperGlobal = "G"\n',
    );

    const c = buildCompiledClosure(mainPath, {});
    expect(c.plans[mainPath]!.global.awaitModules).toEqual([helperPath]);
    // localOrder still doesn't include bare slots — codegen emits them
    // inline via the section assembler.
    expect(c.plans[mainPath]!.global.localOrder).toEqual([]);
  });
});
