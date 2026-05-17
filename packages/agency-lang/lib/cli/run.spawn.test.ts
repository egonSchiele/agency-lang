import { describe, it, expect } from "vitest";
import { compileWarning, compiledOutputEnv } from "./commands.js";
import { installDirFromUrl, nodeModulesParent } from "./installLocation.js";

describe("compiledOutputEnv", () => {
  it("injects NODE_PATH pointing at the CLI's resolution root", () => {
    const env = compiledOutputEnv({ existing: "x" } as NodeJS.ProcessEnv);
    const expected = nodeModulesParent(installDirFromUrl(import.meta.url));
    expect(env.NODE_PATH ?? "").toContain(expected);
    expect(env.existing).toBe("x");
  });
  it("appends to existing NODE_PATH rather than overwriting", () => {
    const env = compiledOutputEnv({
      NODE_PATH: "/some/path",
    } as NodeJS.ProcessEnv);
    expect(env.NODE_PATH?.startsWith("/some/path")).toBe(true);
    expect(env.NODE_PATH?.length).toBeGreaterThan("/some/path".length);
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
