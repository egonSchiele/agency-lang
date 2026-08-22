import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  validateClosure,
  snapshotValidatedClosureForTest,
  ClosureValidationError,
} from "./closureValidator.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

function cleanup(dir: string): void {
  expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
}

function violationsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ClosureValidationError) return e.violations;
    throw e;
  }
  throw new Error("expected ClosureValidationError");
}

const HELPER = "export def helperValue(): number { return 7 }\n";

describe("validateClosure", () => {
  test("entry + relative local import: both modules", () => {
    const dir = makeDir(".cv-rel-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { helperValue } from "./helper.agency"\nexport node main(): number { return helperValue() }\n',
      );
      const closure = validateClosure({ entry: { file: "main.agency" }, dir });
      const snap = snapshotValidatedClosureForTest(closure);
      expect(snap.moduleRelativePaths.sort()).toEqual(["helper.agency", "main.agency"]);
      expect(snap.root).not.toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  test("import escaping the dir via .. is refused", () => {
    const parent = makeDir(".cv-esc-");
    try {
      const dir = path.join(parent, "inner");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(parent, "outside.agency"), HELPER);
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { helperValue } from "../outside.agency"\nexport node main(): number { return helperValue() }\n',
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/outside the sandbox dir/);
      expect(violations.join("\n")).toContain("../outside.agency");
    } finally {
      cleanup(parent);
    }
  });

  test("symlink inside dir pointing outside is refused", () => {
    const parent = makeDir(".cv-symesc-");
    try {
      const dir = path.join(parent, "inner");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(parent, "secret.agency"), HELPER);
      fs.symlinkSync(path.join(parent, "secret.agency"), path.join(dir, "link.agency"));
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { helperValue } from "./link.agency"\nexport node main(): number { return helperValue() }\n',
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/outside the sandbox dir/);
    } finally {
      cleanup(parent);
    }
  });

  test("a symlink inside dir is refused even when its target is inside dir", () => {
    const dir = makeDir(".cv-alias-");
    try {
      fs.writeFileSync(path.join(dir, "real.agency"), HELPER);
      fs.symlinkSync(path.join(dir, "real.agency"), path.join(dir, "alias.agency"));
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { helperValue } from "./alias.agency"\nexport node main(): number { return helperValue() }\n',
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/symlink/);
      expect(violations.join("\n")).toContain("./alias.agency");
    } finally {
      cleanup(dir);
    }
  });

  test("a symlinked entry file is refused", () => {
    const dir = makeDir(".cv-entrylink-");
    try {
      fs.writeFileSync(path.join(dir, "real.agency"), "export node main(): number { return 1 }\n");
      fs.symlinkSync(path.join(dir, "real.agency"), path.join(dir, "main.agency"));
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/symlink/);
    } finally {
      cleanup(dir);
    }
  });

  test("a FIFO named like a module is refused without blocking the compiler", () => {
    const dir = makeDir(".cv-fifo-");
    try {
      // No writer ever opens the pipe, so a blocking open or read would
      // hang this test forever; the validator must open non-blocking and
      // refuse on fstat.
      execFileSync("mkfifo", [path.join(dir, "pipe.agency")]);
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { x } from "./pipe.agency"\nexport node main(): number { return 1 }\n',
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/not a regular file/);
    } finally {
      cleanup(dir);
    }
  });

  test("an absolute local import is refused", () => {
    const dir = makeDir(".cv-abs-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        `import { helperValue } from "${path.join(dir, "helper.agency")}"\n` +
          "export node main(): number { return helperValue() }\n",
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/absolute path/);
    } finally {
      cleanup(dir);
    }
  });

  test("pkg:: imports are refused", () => {
    const dir = makeDir(".cv-pkg-");
    try {
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { helperValue } from "pkg::testpkg"\nexport node main(): number { return helperValue() }\n',
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/pkg:: imports are not supported/);
    } finally {
      cleanup(dir);
    }
  });

  test("a local .ts import is refused as not Agency source", () => {
    const dir = makeDir(".cv-ts-");
    try {
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { x } from "./helper.ts"\nexport node main(): number { return x }\n',
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/not Agency source/);
      expect(violations.join("\n")).toContain("./helper.ts");
    } finally {
      cleanup(dir);
    }
  });

  test("node builtins are refused", () => {
    const dir = makeDir(".cv-node-");
    try {
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import fs from "fs"\nimport cp from "child_process"\nexport node main(): number { return 1 }\n',
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      const text = violations.join("\n");
      expect(text).toMatch(/'fs'/);
      expect(text).toMatch(/'child_process'/);
      expect(text).toMatch(/not Agency source/);
    } finally {
      cleanup(dir);
    }
  });

  test("a splice in an imported file is a violation, listed beside an import violation", () => {
    const dir = makeDir(".cv-splice-");
    try {
      fs.writeFileSync(
        path.join(dir, "gen.agency"),
        "$( makeCode() )\nexport def g(): number { return 1 }\n",
      );
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { g } from "./gen.agency"\nimport fs from "fs"\nexport node main(): number { return g() }\n',
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      const text = violations.join("\n");
      expect(text).toMatch(/compile-time splice/);
      expect(text).toMatch(/'fs'/);
    } finally {
      cleanup(dir);
    }
  });

  test("an unsafe file reached through a re-export edge is refused", () => {
    const dir = makeDir(".cv-reexp-");
    try {
      fs.writeFileSync(
        path.join(dir, "y.agency"),
        'import fs from "fs"\nexport def x(): number { return 1 }\n',
      );
      fs.writeFileSync(path.join(dir, "main.agency"), 'export { x } from "./y.agency"\n');
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/'fs'/);
    } finally {
      cleanup(dir);
    }
  });

  test("an unsafe file reached through a deprecated import-node edge is refused", () => {
    const dir = makeDir(".cv-impnode-");
    try {
      fs.writeFileSync(
        path.join(dir, "nodes.agency"),
        'import fs from "fs"\nexport node helper(): number { return 1 }\n',
      );
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import nodes { helper } from "./nodes.agency"\nexport node main(): number { return 1 }\n',
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/'fs'/);
    } finally {
      cleanup(dir);
    }
  });

  test("string entry with a relative import resolving inside dir works", () => {
    const dir = makeDir(".cv-strentry-");
    try {
      fs.writeFileSync(path.join(dir, "helper.agency"), HELPER);
      const closure = validateClosure({
        entry: {
          source:
            'import { helperValue } from "./helper.agency"\nexport node main(): number { return helperValue() }\n',
        },
        dir,
      });
      const snap = snapshotValidatedClosureForTest(closure);
      expect(snap.moduleRelativePaths).toContain("helper.agency");
    } finally {
      cleanup(dir);
    }
  });

  test("dir '' refuses any local import and never resolves to cwd", () => {
    const violations = violationsOf(() =>
      validateClosure({
        entry: {
          source:
            'import { x } from "./package.json.agency"\nexport node main(): number { return 1 }\n',
        },
        dir: "",
      }),
    );
    expect(violations.join("\n")).toMatch(/no sandbox dir/i);
  });

  test("dir '' with only std:: imports yields a null root and one virtual entry module", () => {
    const closure = validateClosure({
      entry: { source: "export node main(): number { return 1 }\n" },
      dir: "",
    });
    const snap = snapshotValidatedClosureForTest(closure);
    expect(snap.root).toBeNull();
    expect(snap.moduleRelativePaths.length).toBe(1);
  });

  test("missing file, broken symlink, and parse failures become named diagnostics", () => {
    const dir = makeDir(".cv-diags-");
    try {
      fs.symlinkSync(path.join(dir, "nowhere.agency"), path.join(dir, "broken.agency"));
      fs.writeFileSync(path.join(dir, "bad.agency"), "def oops(:::\n");
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { a } from "./missing.agency"\n' +
          'import { b } from "./broken.agency"\n' +
          'import { c } from "./bad.agency"\n' +
          "export node main(): number { return 1 }\n",
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      const text = violations.join("\n");
      expect(text).toContain("./missing.agency");
      expect(text).toContain("./broken.agency");
      expect(text).toContain("bad.agency");
      expect(violations.length).toBeGreaterThanOrEqual(3);
    } finally {
      cleanup(dir);
    }
  });

  test("an import cycle terminates; each module recorded once", () => {
    const dir = makeDir(".cv-cycle-");
    try {
      fs.writeFileSync(
        path.join(dir, "a.agency"),
        'import { b } from "./b.agency"\nexport def a(): number { return 1 }\n',
      );
      fs.writeFileSync(
        path.join(dir, "b.agency"),
        'import { a } from "./a.agency"\nexport def b(): number { return 2 }\n',
      );
      fs.writeFileSync(
        path.join(dir, "main.agency"),
        'import { a } from "./a.agency"\nexport node main(): number { return a() }\n',
      );
      const snap = snapshotValidatedClosureForTest(
        validateClosure({ entry: { file: "main.agency" }, dir }),
      );
      expect(snap.moduleRelativePaths.sort()).toEqual(["a.agency", "b.agency", "main.agency"]);
    } finally {
      cleanup(dir);
    }
  });

  test("a file entry outside dir is refused before reading it", () => {
    const parent = makeDir(".cv-entryout-");
    try {
      const dir = path.join(parent, "inner");
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(parent, "main.agency"),
        "export node main(): number { return 1 }\n",
      );
      const violations = violationsOf(() =>
        validateClosure({ entry: { file: "../main.agency" }, dir }),
      );
      expect(violations.join("\n")).toMatch(/outside the sandbox dir/);
    } finally {
      cleanup(parent);
    }
  });

  test("a string entry importing a real file named __entry__.agency does not collide", () => {
    const dir = makeDir(".cv-entrycol-");
    try {
      fs.writeFileSync(path.join(dir, "__entry__.agency"), HELPER);
      const closure = validateClosure({
        entry: {
          source:
            'import { helperValue } from "./__entry__.agency"\nexport node main(): number { return helperValue() }\n',
        },
        dir,
      });
      const snap = snapshotValidatedClosureForTest(closure);
      expect(snap.moduleRelativePaths).toContain("__entry__.agency");
      expect(snap.moduleRelativePaths.length).toBe(2);
      const others = snap.moduleRelativePaths.filter((p) => p !== "__entry__.agency");
      expect(others.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });
});
