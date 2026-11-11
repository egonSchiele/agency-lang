import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as path from "path";

// The check is a script, so these tests run it as one, over the fixture
// folders in tests/lint-dev-docs-index/. Each holds an index.md (not a
// CLAUDE.md, which Claude Code would load as instructions) and a docs/dev/.
const script = path.resolve(__dirname, "lint-dev-docs-index.mjs");
const fixtures = path.resolve(__dirname, "../tests/lint-dev-docs-index");

function runCheck(fixture: string): { status: number | null; output: string } {
  const root = path.join(fixtures, fixture);
  const result = spawnSync(
    "node",
    [script, "--root", root, "--index", path.join(root, "index.md")],
    { encoding: "utf-8", cwd: fixtures },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("lint-dev-docs-index", () => {
  it("passes when every doc is listed once with a short description", () => {
    const result = runCheck("good");
    expect(result.output).toBe("");
    expect(result.status).toBe(0);
  });

  describe("on an index with every kind of problem", () => {
    const result = runCheck("bad");

    it("fails", () => {
      expect(result.status).toBe(1);
    });

    it("reports a description over the limit", () => {
      expect(result.output).toContain(
        "bad/index.md:5: the description of docs/dev/listed.md is 193 characters; the limit is 150.",
      );
    });

    it("reports a file listed twice", () => {
      expect(result.output).toContain("bad/index.md:6: docs/dev/listed.md is listed twice");
    });

    it("reports an entry naming a missing file", () => {
      expect(result.output).toContain("bad/index.md:7: docs/dev/missing.md does not exist");
    });

    it("reports an entry with no description", () => {
      expect(result.output).toContain("bad/index.md:8: docs/dev/bare.md has no description");
    });

    it("reports a doc the index does not list", () => {
      expect(result.output).toContain("docs/dev/unlisted.md is not listed in bad/index.md");
    });
  });

  it("fails when the index has no Deeper docs section", () => {
    const result = spawnSync(
      "node",
      [script, "--root", path.join(fixtures, "good"), "--index", script],
      { encoding: "utf-8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no "## Deeper docs" section');
  });
});
