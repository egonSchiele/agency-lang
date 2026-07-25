import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SymbolTable } from "../symbolTable.js";
import { uniqueInterruptEffects } from "./policy.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

let dir: string;
beforeEach(() => {
  dir = makeAgencyTempDir("policycross");
});
afterEach(() => {
  safeDeleteDirectory(dir, false);
});

describe("agency policy gen across a file boundary", () => {
  it("lists an effect reached through an imported helper", () => {
    // policyGen writes files and calls process.exit, so this drives the
    // function that decides what goes in the policy rather than the command.
    // An empty list is what makes it print "No policy needed" and write
    // nothing, which is what this program used to do.
    fs.writeFileSync(
      path.join(dir, "helper.agency"),
      `export def h(): string {\n  return read("data.txt")\n}\n`,
      "utf-8",
    );
    const main = path.join(dir, "main.agency");
    fs.writeFileSync(
      main,
      `import { h } from "./helper.agency"\nnode main() {\n  const x = h()\n}\n`,
      "utf-8",
    );

    const table = SymbolTable.build(main, {});
    // Passing an empty type-checker map on purpose: it proves the symbol
    // table's list alone is now sufficient, which is the whole change.
    const effects = uniqueInterruptEffects(table.getFile(path.resolve(main)), {});
    expect(effects).toEqual(["std::read"]);
  });
});
