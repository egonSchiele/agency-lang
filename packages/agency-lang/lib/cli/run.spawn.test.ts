import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { fileURLToPath } from "url";
import {
  compileWarning,
  compiledOutputNodeArgs,
  compiledOutputRegisterUrl,
} from "./commands.js";

describe("compiledOutputRegisterUrl", () => {
  it("returns a file:// URL pointing at the shipped register.mjs", () => {
    const url = compiledOutputRegisterUrl();
    expect(url.startsWith("file://")).toBe(true);
    // Under vitest the URL points at lib/cli/runShim (source); in the built
    // tree it would point at dist/lib/cli/runShim. Either is correct.
    expect(url.endsWith("/lib/cli/runShim/register.mjs")).toBe(true);
  });
  it("points at a file that exists on disk", () => {
    const url = compiledOutputRegisterUrl();
    const filePath = fileURLToPath(url);
    expect(fs.existsSync(filePath)).toBe(true);
  });
  it("points at a register.mjs sitting next to resolver.mjs", () => {
    // The register shim is useless without the resolver next to it.
    const registerUrl = compiledOutputRegisterUrl();
    const resolverPath = fileURLToPath(registerUrl).replace(
      /register\.mjs$/,
      "resolver.mjs",
    );
    expect(fs.existsSync(resolverPath)).toBe(true);
  });
});

describe("compiledOutputNodeArgs", () => {
  it("includes a --import flag pointing at the register shim", () => {
    const args = compiledOutputNodeArgs();
    expect(args.length).toBe(1);
    expect(args[0].startsWith("--import=file://")).toBe(true);
    expect(args[0].endsWith("/lib/cli/runShim/register.mjs")).toBe(true);
  });
});

describe("compileWarning", () => {
  it("returns a warning string when install is global", () => {
    const out = compileWarning("global", "/tmp/foo.js");
    expect(out).not.toBeNull();
    expect(out!).toMatch(/agency-lang.*global/);
    expect(out!).toMatch(/agency run/);
    expect(out!).toMatch(/agency pack/);
  });
  it("returns null when install is local", () => {
    expect(compileWarning("local", "/tmp/foo.js")).toBeNull();
  });
  it("returns null when install is workspace", () => {
    expect(compileWarning("workspace", "/tmp/foo.js")).toBeNull();
  });
});
