import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _compileFile } from "./agency.js";

// Sentinel string baked into the inside-the-sandbox source. The compiled JS
// has to contain it — that's what proves _compileFile actually read THIS
// file (and not, say, accidentally read outside.agency because the
// containment check was broken open).
const INSIDE_SENTINEL = "sentinel_inside_payload_xyz";

describe("_compileFile sandbox containment", () => {
  let sandbox: string;
  let outsideFile: string;
  // Sibling directory whose path shares a prefix with `sandbox`. Used to
  // attack the `+ sep` defense — without the trailing separator,
  // "/tmp/sandbox-abc".startsWith("/tmp/sandbox-ab") would be true.
  let siblingDir: string;
  let siblingFile: string;

  beforeAll(() => {
    // Layout:
    //   <tmp>/
    //     sandbox-XXXX/
    //       inside.agency      <- legal target
    //     sandbox-XXXX-evil/   <- shares string prefix with sandbox
    //       sneaky.agency      <- sibling-prefix attack target
    //     outside.agency        <- target the sandbox must NOT reach
    sandbox = mkdtempSync(join(tmpdir(), "agency-sandbox-"));
    writeFileSync(
      join(sandbox, "inside.agency"),
      `node main() { return "${INSIDE_SENTINEL}" }`,
      "utf-8",
    );
    outsideFile = join(sandbox, "..", "outside.agency");
    writeFileSync(
      outsideFile,
      `node main() { return "should not be reachable" }`,
      "utf-8",
    );
    siblingDir = `${sandbox}-evil`;
    mkdirSync(siblingDir);
    siblingFile = join(siblingDir, "sneaky.agency");
    writeFileSync(
      siblingFile,
      `node main() { return "should not be reachable" }`,
      "utf-8",
    );
  });

  afterAll(() => {
    try { rmSync(sandbox, { recursive: true }); } catch (_) { /* best effort */ }
    try { rmSync(outsideFile); } catch (_) { /* best effort */ }
    try { rmSync(siblingDir, { recursive: true }); } catch (_) { /* best effort */ }
  });

  it("compiles a file that lives inside the sandbox dir, and produces JS derived from THAT file", () => {
    const result = _compileFile(sandbox, "inside.agency");
    expect(result.moduleId).toBeTruthy();
    expect(result.path).toContain(result.moduleId);
    // Crucial: prove the compiled output came from inside.agency and not,
    // e.g., outside.agency. The sentinel string from inside.agency must
    // appear in the emitted JS.
    const compiled = readFileSync(result.path, "utf-8");
    expect(compiled).toContain(INSIDE_SENTINEL);
  });

  it("rejects a filename containing .. that escapes the sandbox", () => {
    expect(() => _compileFile(sandbox, "../outside.agency")).toThrowError(
      /Sandbox violation/,
    );
  });

  it("rejects an absolute filename outside the sandbox", () => {
    expect(() => _compileFile(sandbox, outsideFile)).toThrowError(
      /Sandbox violation/,
    );
  });

  it("rejects a sibling directory whose path shares a prefix with the sandbox", () => {
    // Without the trailing `+ sep` on the prefix check, this would slip
    // through: "/tmp/sandbox-abc-evil/sneaky.agency" startsWith
    // "/tmp/sandbox-abc" is true. The `+ sep` is what makes this fail.
    expect(() =>
      _compileFile(sandbox, join("..", `${sandbox.split("/").pop()}-evil`, "sneaky.agency")),
    ).toThrowError(/Sandbox violation/);
  });

  it("rejects a symlink that points outside the sandbox", (ctx) => {
    // Create a symlink inside the sandbox that points to a file outside.
    // realpath on the symlink should resolve to the outside path, which
    // then fails the startsWith check.
    const link = join(sandbox, "evil.agency");
    try {
      symlinkSync(outsideFile, link);
    } catch (_) {
      // Symlink creation may fail on some CI environments / restricted
      // filesystems / Windows. Skip rather than silently pass — a real
      // regression in the symlink defense should be visible.
      ctx.skip();
      return;
    }
    expect(() => _compileFile(sandbox, "evil.agency")).toThrowError(
      /Sandbox violation/,
    );
  });

  it("calls compileSource with restrictImports: true (subprocess code can't import 'fs')", () => {
    // If _compileFile ever stops passing restrictImports: true, this test
    // catches it. We write an inside-the-sandbox file that imports 'fs'
    // and assert _compileFile rejects it with the same error compileSource
    // produces under restrictImports.
    writeFileSync(
      join(sandbox, "imports-fs.agency"),
      `import { readFileSync } from "fs"\nnode main() { return "x" }`,
      "utf-8",
    );
    expect(() => _compileFile(sandbox, "imports-fs.agency")).toThrowError(
      /npm\/Node module import/,
    );
  });
});
