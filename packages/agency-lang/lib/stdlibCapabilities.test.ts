import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseAgency } from "./parser.js";
import { effectDeclarationsWithTags } from "./utils/tagsAbove.js";
import { readCapabilities } from "./typeChecker/capabilitiesTag.js";

function agencyFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return agencyFilesUnder(full);
    }
    return entry.name.endsWith(".agency") ? [full] : [];
  });
}

/** Every `effect std::` declaration in the stdlib must say what it needs
 *  from the host, even when that is nothing (`@capabilities`). The
 *  platform check and the runtime refusal both read the tag, so an
 *  untagged stdlib effect would pass everywhere and fail on the host. */
describe("stdlib effect declarations", () => {
  it("every effect std:: declaration carries a @capabilities tag", () => {
    const untagged: string[] = [];
    const broken: string[] = [];
    for (const file of agencyFilesUnder(path.join(process.cwd(), "stdlib"))) {
      const parsed = parseAgency(fs.readFileSync(file, "utf8"));
      if (!parsed.success) {
        throw new Error(`failed to parse ${file}`);
      }
      for (const decl of effectDeclarationsWithTags(parsed.result.nodes)) {
        if (!decl.effect.startsWith("std::")) {
          continue;
        }
        const read = readCapabilities(decl.tags);
        if (!read.tagged) {
          untagged.push(`${path.relative(process.cwd(), file)}: ${decl.effect}`);
        }
        if (read.problems.length > 0) {
          broken.push(`${path.relative(process.cwd(), file)}: ${decl.effect}`);
        }
      }
    }
    expect(untagged).toEqual([]);
    expect(broken).toEqual([]);
  });
});
