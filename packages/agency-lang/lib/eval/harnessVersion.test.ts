import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { describe, expect, it } from "vitest";

import { harnessVersion } from "./harnessVersion.js";

const packageJson = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");

describe("harnessVersion", () => {
  it("returns this package's version", () => {
    const { version } = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { version: string };
    expect(harnessVersion()).toBe(version);
  });
});
