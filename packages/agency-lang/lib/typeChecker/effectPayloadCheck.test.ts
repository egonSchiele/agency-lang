import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { typecheckSource } from "./testUtils.js";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function dataErrors(src: string) {
  return typecheckSource(src).filter((e) =>
    /Effect '.*'|[Cc]onflicting|Named arguments/.test(e.message),
  );
}

describe("effect data checking", () => {
  it("passes when the data matches the declaration", () => {
    expect(
      dataErrors(
        "effect std::read { dir: string }\n" +
          'node main() { raise std::read("m", { dir: "/tmp" }) }',
      ),
    ).toHaveLength(0);
  });

  it("errors on a missing required field", () => {
    const errs = typecheckSource(
      "effect std::read { dir: string }\n" +
        'node main() { raise std::read("m", {}) }',
    );
    expect(
      errs.find((e) =>
        /Effect 'std::read' data field 'dir' is missing/.test(e.message),
      ),
    ).toBeDefined();
  });

  it("errors on a wrong field type", () => {
    const errs = typecheckSource(
      "effect std::read { dir: string }\n" +
        'node main() { raise std::read("m", { dir: 5 }) }',
    );
    expect(
      errs.find((e) =>
        /Effect 'std::read' data field 'dir' has the wrong type/.test(
          e.message,
        ),
      ),
    ).toBeDefined();
  });

  it("allows extra fields (structural)", () => {
    expect(
      dataErrors(
        "effect std::read { dir: string }\n" +
          'node main() { raise std::read("m", { dir: "/tmp", extra: 1 }) }',
      ),
    ).toHaveLength(0);
  });

  it("errors when required data is omitted entirely", () => {
    const errs = typecheckSource(
      "effect std::read { dir: string }\n" +
        'node main() { raise std::read("m") }',
    );
    expect(
      errs.find((e) => /Effect 'std::read' expects data/.test(e.message)),
    ).toBeDefined();
  });

  it("empty data declaration permits a raise with no data", () => {
    expect(
      dataErrors(
        'effect std::ping {}\nnode main() { raise std::ping("m") }',
      ),
    ).toHaveLength(0);
  });

  it("empty data declaration tolerates extras (structural)", () => {
    expect(
      dataErrors(
        'effect std::ping {}\nnode main() { raise std::ping("m", { junk: 1 }) }',
      ),
    ).toHaveLength(0);
  });

  it("does not check undeclared effects", () => {
    expect(
      dataErrors(
        'node main() { raise std::read("m", { anything: 1 }) }',
      ),
    ).toHaveLength(0);
  });

  it("checks both interrupt and raise forms", () => {
    const errs = typecheckSource(
      "effect std::read { dir: string }\n" +
        'def f() { return interrupt std::read("m", { dir: 5 }) }',
    );
    expect(
      errs.find((e) =>
        /Effect 'std::read' data field 'dir' has the wrong type/.test(
          e.message,
        ),
      ),
    ).toBeDefined();
  });

  it("errors on conflicting declarations of the same effect", () => {
    const errs = typecheckSource(
      "effect std::read { dir: string }\n" +
        "effect std::read { path: number }\n" +
        'node main() { print("hi") }',
    );
    expect(
      errs.find((e) => /[Cc]onflicting.*std::read/.test(e.message)),
    ).toBeDefined();
  });

  it("does not also flag raise sites of a conflicting effect", () => {
    const errs = typecheckSource(
      "effect std::read { dir: string }\n" +
        "effect std::read { path: number }\n" +
        'node main() { raise std::read("m", { totally: "wrong" }) }',
    );
    const conflictErrs = errs.filter((e) =>
      /[Cc]onflicting.*std::read/.test(e.message),
    );
    const siteErrs = errs.filter((e) =>
      /Effect 'std::read' data/.test(e.message),
    );
    expect(conflictErrs).toHaveLength(1);
    expect(siteErrs).toHaveLength(0);
  });

  it("rejects named arguments at a raise site", () => {
    // `raise`/`interrupt` is positional; there is no parameter name for the data.
    const errs = typecheckSource(
      "effect std::read { dir: string }\n" +
        'node main() { raise std::read("m", data: { dir: "/tmp" }) }',
    );
    expect(
      errs.find((e) =>
        /Named arguments are not allowed on 'raise'\/'interrupt'/.test(
          e.message,
        ),
      ),
    ).toBeDefined();
  });

  it("silently skips splat arguments (Phase-1 limitation)", () => {
    // We can't determine which splat element becomes the data, so don't
    // pretend to check. No diagnostic from the effect-data check itself.
    const errs = dataErrors(
      "effect std::read { dir: string }\n" +
        'node main() { const xs = ["m", { dir: "/tmp" }]\n raise std::read(...xs) }',
    );
    expect(errs).toHaveLength(0);
  });
});

function typecheckImporter(files: Record<string, string>, entry: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-effimp-"));
  try {
    for (const [name, src] of Object.entries(files))
      fs.writeFileSync(path.join(dir, name), src);
    const entryPath = path.join(dir, entry);
    const parsed = parseAgency(files[entry]);
    if (!parsed.success) throw new Error("parse failed");
    const symbols = SymbolTable.build(entryPath);
    const info = buildCompilationUnit(parsed.result, symbols, entryPath);
    return typeCheck(parsed.result, {}, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("effect payload checking — ambient across imports", () => {
  it("checks a raise against an effect declared in an imported module", () => {
    const errs = typecheckImporter(
      {
        "lib.agency":
          "export def noop() { return 1 }\neffect std::read { dir: string }\n",
        "main.agency":
          'import { noop } from "./lib.agency"\n' +
          'node main() { raise std::read("m", { dir: 5 }) }\n',
      },
      "main.agency",
    );
    expect(
      errs.find((e) =>
        /Effect 'std::read' data field 'dir' has the wrong type/.test(
          e.message,
        ),
      ),
    ).toBeDefined();
  });

  it("identical declarations across two files are NOT a conflict or duplicate", () => {
    // The conflict check is *structural*; same payload across files is fine.
    // Without this test, `typesEqual` could be mistakenly tightened (e.g.,
    // to compare AST identity) and pass every other test.
    const errs = typecheckImporter(
      {
        "a.agency":
          "effect std::read { dir: string }\nexport def x() { return 1 }",
        "main.agency":
          'import { x } from "./a.agency"\n' +
          "effect std::read { dir: string }\n" +
          'node main() { raise std::read("m", { dir: "/tmp" }) }',
      },
      "main.agency",
    );
    const offenders = errs.filter((e) =>
      /declared more than once|[Cc]onflicting/.test(e.message),
    );
    expect(offenders).toHaveLength(0);
  });

  it("same-file duplicates are reported per offending file (not globally)", () => {
    // `reportSameFileDuplicates` must iterate per file. If it collapses
    // to one global error, this test catches it — both files have a dup,
    // we expect at least two diagnostics.
    const errs = typecheckImporter(
      {
        "a.agency":
          "effect std::read { dir: string }\n" +
          "effect std::read { dir: string }\n" +
          "export def x() { return 1 }",
        "main.agency":
          'import { x } from "./a.agency"\n' +
          "effect std::read { dir: string }\n" +
          "effect std::read { dir: string }\n" +
          'node main() { print("hi") }',
      },
      "main.agency",
    );
    const dups = errs.filter((e) =>
      /Effect 'std::read' is declared more than once/.test(e.message),
    );
    expect(dups.length).toBeGreaterThanOrEqual(2);
  });
});

describe("effect data checking — fallback paths", () => {
  it("checks a non-object data argument via whole-type assignability", () => {
    // Locks the non-object-type branch of checkRaiseSite. Without this
    // test you could delete the entire fallback block and nothing fails.
    // A primitive variable as the data arg cannot satisfy an ObjectType
    // payload, so the whole-type assignability path must fire.
    const errs = typecheckSource(
      "effect std::read { dir: string }\n" +
        "node main() {\n" +
        "  const bad: number = 5\n" +
        '  raise std::read("m", bad)\n' +
        "}",
    );
    expect(
      errs.find((e) =>
        /Effect 'std::read' data does not match/.test(e.message),
      ),
    ).toBeDefined();
  });

  it("resolves type aliases inside the declared payload", () => {
    // Exercises that `getTypeAliases()` is threaded through to isAssignable.
    expect(
      dataErrors(
        "type Path = string\n" +
          "effect std::read { dir: Path }\n" +
          'node main() { raise std::read("m", { dir: "/tmp" }) }',
      ),
    ).toHaveLength(0);
  });
});
