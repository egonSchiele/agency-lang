import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { embedServerScript } from "./localServe.js";

describe("mlxEmbedServer.py", () => {
  it("ships next to localServe", () => {
    const script = embedServerScript();
    expect(script.endsWith("/lib/cli/mlxEmbedServer.py")).toBe(true);
    expect(fs.existsSync(script)).toBe(true);
  });

  // A syntax check only. Running the server needs MLX, which CI has not.
  // ast.parse rather than py_compile: py_compile writes __pycache__ next
  // to the script, and nothing ignores that directory.
  it("is valid Python 3", () => {
    const run = spawnSync(
      "python3",
      ["-c", "import ast, sys; ast.parse(open(sys.argv[1]).read())", embedServerScript()],
      { stdio: "pipe" },
    );
    if (run.error !== undefined && (run.error as { code?: string }).code === "ENOENT") {
      return;
    }
    expect(run.stderr.toString()).toBe("");
    expect(run.status).toBe(0);
  });
});
