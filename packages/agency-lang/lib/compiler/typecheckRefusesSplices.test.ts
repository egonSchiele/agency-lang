import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { safeDeleteDirectory } from "../utils.js";
import { typeCheckSource } from "./typecheck.js";

/**
 * `--refuse-splices` on the type-checking path.
 *
 * This pipeline RUNS generators, which is easy to miss: it hands the checker
 * a real on-disk path so relative imports resolve, and that is also what lets
 * a splice resolve its generator against that directory and execute it. It
 * took a config parameter of `{}` before this, so no caller could decline.
 */
let dir: string;

beforeEach(() => {
  dir = path.join(process.cwd(), ".agency-tmp", `tc-refuse-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
  // The fragment declares a TYPE, and host.agency annotates with it. The type
  // is the witness, deliberately: a call to a function that does not exist is
  // reported silently here, so a generated *function* proves nothing — an
  // unexpanded program with `print(greet())` still type-checks clean. An
  // unknown type alias is a real error (AG1006), so this fixture fails if
  // expansion ever stops happening.
  fs.writeFileSync(
    path.join(dir, "gen.agency"),
    `import { Code } from "std::agency"\n\nexport def makeGreet(): Code {\n  return [|\n    type Greeting = string\n\n    def greet(): Greeting {\n      return "hi"\n    }\n  |]\n}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "host.agency"),
    `import { makeGreet } from "./gen.agency"\n\n$( makeGreet() )\n\nnode main() {\n  const g: Greeting = greet()\n  print(g)\n}\n`,
    "utf-8",
  );
});

afterEach(() => {
  safeDeleteDirectory(dir, false);
});

function check(file: string, refuseSplices?: boolean) {
  const target = path.join(dir, file);
  const source = fs.readFileSync(target, "utf-8");
  return typeCheckSource(source, target, refuseSplices ? { refuseSplices: true } : {});
}

describe("type checking with generator execution declined", () => {
  // A refusal is not a diagnostic in the report: continuing would answer as
  // though the file had no splice, reporting every generated name as
  // undefined. It throws, joining this pipeline's rule that a throw means
  // "could not check this".
  it("refuses instead of running the generator", () => {
    expect(() => check("host.agency", true)).toThrow(/AG8016/);
  });

  it("names the generator that was declined", () => {
    expect(() => check("host.agency", true)).toThrow(/makeGreet/);
  });

  it("still expands when the caller does not decline", () => {
    // The control that stops the flag from becoming a blanket ban. A clean
    // report only means something because of the generated type: without
    // expansion this reports AG1006 for the unknown `Greeting`. Verified by
    // disabling expansion in runCheckerPipeline, which fails this test.
    expect(check("host.agency").errors).toHaveLength(0);
  }, 60_000);

  it("costs a splice-free file nothing", () => {
    fs.writeFileSync(path.join(dir, "plain.agency"), `node main() {\n  print("hi")\n}\n`, "utf-8");
    expect(check("plain.agency", true).errors).toHaveLength(0);
  });
});
