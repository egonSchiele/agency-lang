import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { safeDeleteDirectory } from "../../utils.js";
import { parseAgency } from "../../parser.js";
import { clearSpliceCache } from "./cache.js";
import { expandSplices } from "../../preprocessors/expandSplices.js";
import type { AgencyProgram } from "../../types.js";

/** Count real generator runs. Timing would be flaky, and watching for temp
 *  directories cannot work, since expansion is synchronous. */
const spy = vi.hoisted(() => ({ runs: 0 }));

vi.mock("./runGenerator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runGenerator.js")>();
  return {
    ...actual,
    runGenerator: (...args: Parameters<typeof actual.runGenerator>) => {
      spy.runs += 1;
      return actual.runGenerator(...args);
    },
  };
});

/**
 * What happens on the second compile. Every other splice test runs on a
 * cold cache, which is the easy half.
 */

let dir: string;

beforeEach(() => {
  dir = path.join(process.cwd(), ".agency-tmp", `splice-rebuild-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
  clearSpliceCache();
});

afterEach(() => {
  safeDeleteDirectory(dir, false);
  clearSpliceCache();
  spy.runs = 0;
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

const HOST = `import { g } from "./gen.agency"\n\n$( g() )\n`;

/** A generator returning a function whose body is `body`. */
function writeGenerator(body: string): void {
  write(
    "gen.agency",
    `import { Code } from "std::agency"\n\nexport def g(): Code {\n  return [|\n    def value(): string {\n      return ${body}\n    }\n  |]\n}\n`,
  );
}

/** Expand the host file and return the generated function's body text. */
function expandAndRead(hostPath: string): string {
  const result = expandSplices(parse(HOST), hostPath, {});
  if (!result.ok) {
    throw new Error(`expansion failed: ${result.diagnostic.diagnostic}`);
  }
  return JSON.stringify(result.value);
}


describe("rebuilding a file with a splice", () => {
  it("picks up an edited generator", () => {
    const hostPath = write("host.agency", HOST);
    writeGenerator(`"first"`);
    const before = expandAndRead(hostPath);
    expect(before).toContain("first");

    writeGenerator(`"second"`);
    const after = expandAndRead(hostPath);
    expect(after).toContain("second");
    expect(after).not.toContain("first");
  }, 60_000);

  it("picks up an edited helper one import away", () => {
    // Why the cache key hashes a whole closure. The generator fills what
    // the helper returns into the code it produces.
    const hostPath = write("host.agency", HOST);
    write("helper.agency", `export def label(): string {\n  return "old"\n}\n`);
    write(
      "gen.agency",
      `import { Code, fill } from "std::agency"\nimport { label } from "./helper.agency"\n\nexport def g(): Code {\n  const filled = fill([|\n    def value(): string {\n      return #text: string\n    }\n  |], { text: label() })\n  if (isFailure(filled)) {\n    return [| 0 |]\n  }\n  return filled.value\n}\n`,
    );
    expect(expandAndRead(hostPath)).toContain("old");

    write("helper.agency", `export def label(): string {\n  return "new"\n}\n`);
    const after = expandAndRead(hostPath);
    expect(after).toContain("new");
    expect(after).not.toContain("old");
  }, 60_000);

  it("does not re-run the generator when nothing changed", () => {
    // The point of the cache. The LSP rebuilds on every keystroke, so a
    // second expansion of unchanged input must cost nothing.
    const hostPath = write("host.agency", HOST);
    writeGenerator(`"steady"`);

    expandAndRead(hostPath);
    expect(spy.runs).toBe(1);

    expandAndRead(hostPath);
    expandAndRead(hostPath);
    expect(spy.runs).toBe(1);
  }, 60_000);

  it("produces the same output warm as cold", () => {
    const hostPath = write("host.agency", HOST);
    writeGenerator(`"same"`);
    expect(expandAndRead(hostPath)).toBe(expandAndRead(hostPath));
  }, 60_000);
});
