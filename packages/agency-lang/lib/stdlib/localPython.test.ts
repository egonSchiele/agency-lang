import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { serverRulesDir } from "./localPython.js";

describe("serverRulesDir", () => {
  it("holds the image server's rules module", () => {
    expect(fs.existsSync(path.join(serverRulesDir(), "diffusersImageRules.py"))).toBe(true);
  });
});
