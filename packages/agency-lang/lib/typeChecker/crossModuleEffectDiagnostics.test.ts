import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { typeCheckSource } from "../compiler/typecheck.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

let dir: string;
beforeEach(() => {
  dir = makeAgencyTempDir("crossmoddiag");
});
afterEach(() => {
  safeDeleteDirectory(dir, false);
});

/** typeCheckSource needs the two-argument form here: the one-argument form
 *  writes to a temp directory where ./helper.agency does not exist, and import
 *  resolution throws rather than reporting. */
function check(mainSource: string) {
  fs.writeFileSync(
    path.join(dir, "helper.agency"),
    `export def h(): string {\n  return read("data.txt")\n}\n`,
    "utf-8",
  );
  const main = path.join(dir, "main.agency");
  fs.writeFileSync(main, mainSource, "utf-8");
  return typeCheckSource(mainSource, main);
}

const IMPORT = `import { h } from "./helper.agency"\n`;

describe("effects reaching diagnostics across a file boundary", () => {
  it("AG3009 warns when a node calls an imported wrapper unhandled", () => {
    const report = check(`${IMPORT}node main() {\n  const x = h()\n}\n`);
    expect(report.warnings.map((warning) => warning.code)).toContain("AG3009");
  });

  it("AG3009 stays quiet when the call is inside a handle block", () => {
    // Suppression is lexical: isInsideHandler walks the ancestor chain for a
    // handleBlock, so the call has to be INSIDE the block, not beside it.
    const report = check(
      `${IMPORT}node main() {\n` +
        `  handle {\n    const x = h()\n  } with (data) {\n    return approve()\n  }\n}\n`,
    );
    expect(report.warnings.map((warning) => warning.code)).not.toContain("AG3009");
    expect(report.errors).toEqual([]);
  });

  it("AG3011 rejects a callback body that calls an imported wrapper", () => {
    const report = check(
      `${IMPORT}node main() {\n  callback("onThing") {\n    const x = h()\n  }\n}\n`,
    );
    expect(report.errors.map((error) => error.code)).toContain("AG3011");
  });

  it("AG3013 rejects a raises clause that an imported call exceeds", () => {
    const report = check(
      `${IMPORT}export def caller(): string raises <std::exec> {\n  return h()\n}\n`,
    );
    expect(report.errors.map((error) => error.code)).toContain("AG3013");
  });

  it("AG3013 accepts a raises clause that covers the imported call", () => {
    const report = check(
      `${IMPORT}export def caller(): string raises <std::read> {\n  return h()\n}\n`,
    );
    expect(report.errors.map((error) => error.code)).not.toContain("AG3013");
  });

  it("AG3016 rejects a finalize block that calls an imported wrapper", () => {
    const report = check(
      `${IMPORT}export def caller(): string {\n` +
        `  return "hi"\n\n` +
        `  finalize {\n    const x = h()\n    return "partial"\n  }\n}\n`,
    );
    expect(report.errors.map((error) => error.code)).toContain("AG3016");
  });
});

describe("handler parameter typing across a file boundary", () => {
  /** A handler's parameter is typed from what the handled body can raise, so
   *  an incomplete `match (e.effect)` is reported. Exhaustiveness is what
   *  makes this bite: a loose fallback type would accept any field, so
   *  reading a real field off the parameter would prove nothing. */
  function checkHandler(arms: string) {
    fs.writeFileSync(
      path.join(dir, "effects.agency"),
      `effect mytest::alpha { }\neffect mytest::beta { }\n` +
        `export def risky() {\n  raise mytest::alpha("a", {})\n  raise mytest::beta("b", {})\n}\n`,
      "utf-8",
    );
    const source =
      `import { risky } from "./effects.agency"\n` +
      `node main() {\n  handle {\n    risky()\n  } with (e) {\n` +
      `    match (e.effect) {\n${arms}\n    }\n  }\n}\n`;
    const main = path.join(dir, "main.agency");
    fs.writeFileSync(main, source, "utf-8");
    const report = typeCheckSource(source, main);
    return [...report.errors, ...report.warnings].filter((diagnostic) =>
      /not exhaustive/i.test(diagnostic.message),
    );
  }

  it("reports a match that misses an effect raised by an imported function", () => {
    const missing = checkHandler(`      "mytest::alpha" => 1`);
    expect(missing.some((diagnostic) => /beta/.test(diagnostic.message))).toBe(true);
  });

  it("accepts a match that covers every effect the imported function raises", () => {
    const covered = checkHandler(`      "mytest::alpha" => 1\n      "mytest::beta" => 2`);
    expect(covered).toEqual([]);
  });
});
