import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pack } from "../cli/pack.js";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { createBuildSession } from "./buildSession.js";
import { compileSource } from "./compile.js";

const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const TIMEOUT = 60_000;
const DEFINITION = `
decorator def identify(call, block) {
  return { id: call.id, inToolCall: call.inToolCall }
}

@identify
export def selected(): any {
  return null
}
`;
const PROGRAM = `${DEFINITION}
node main() {
  return selected()
}
`;

type CallMetadata = { id: string; inToolCall: boolean };

function runModule(modulePath: string): unknown {
  const source = `
import { main } from ${JSON.stringify(pathToFileURL(modulePath).href)};
console.log(JSON.stringify((await main()).data));
`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      timeout: TIMEOUT,
    }),
  );
}

describe("decorator metadata across compilation outputs", () => {
  let workDir: string;

  beforeEach(() => {
    // Keep executable modules under the package so their runtime imports resolve.
    workDir = mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-decorator-metadata-"));
  });

  afterEach(() => {
    const removed = safeDeleteDirectoryWithin(PACKAGE_ROOT, workDir);
    if (!removed.success) {
      throw new Error(removed.message);
    }
  });

  it("uses compileSource's generated module identity", () => {
    const result = compileSource(PROGRAM, {});
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.errors.join("\n"));
    }
    const output = path.join(workDir, "generated.mjs");
    writeFileSync(output, result.code);

    expect(runModule(output)).toEqual({
      id: `${result.moduleId}:selected`,
      inToolCall: false,
    });
  });

  it("uses the supplied fingerprint identity instead of the source path", () => {
    const sourcePath = path.join(workDir, "source.agency");
    writeFileSync(sourcePath, PROGRAM);
    const fingerprintModuleId = "deployment/tools.agency";
    const result = compileSource(PROGRAM, { sourcePath, fingerprintModuleId });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.errors.join("\n"));
    }
    const output = path.join(workDir, "fingerprinted.mjs");
    writeFileSync(output, result.code);

    expect(runModule(output)).toEqual({
      id: `${fingerprintModuleId}:selected`,
      inToolCall: false,
    });
  });

  it("keeps a function's identity when outDir relocates its output", () => {
    writeFileSync(path.join(workDir, "source.agency"), PROGRAM);
    const previousCwd = process.cwd();
    try {
      process.chdir(workDir);
      const besideSource = createBuildSession().compile(
        {},
        { entries: ["source.agency"], quiet: true },
      );
      const relocated = createBuildSession().compile(
        { outDir: path.join(workDir, "built") },
        { entries: ["source.agency"], quiet: true },
      );
      expect(besideSource).not.toBeNull();
      expect(relocated).toBe(path.join(workDir, "built", "source.js"));
      const original = runModule(path.resolve(besideSource!));
      expect(original).toEqual({ id: "source.agency:selected", inToolCall: false });
      expect(runModule(relocated!)).toEqual(original);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it(
    "keeps same-named definitions in same-named files distinct after packing",
    async () => {
      for (const directory of ["a", "b"]) {
        mkdirSync(path.join(workDir, directory));
        writeFileSync(path.join(workDir, directory, "tools.agency"), DEFINITION);
      }
      const entry = path.join(workDir, "main.agency");
      writeFileSync(
        entry,
        `
import { selected as first } from "./a/tools.agency"
import { selected as second } from "./b/tools.agency"

node main() {
  return [first(), second()]
}
`,
      );
      const output = path.join(workDir, "bundle.mjs");
      await pack({ config: {}, inputFile: entry, outputFile: output, target: "node" });

      const records = runModule(output) as CallMetadata[];
      expect(records).toEqual([
        { id: expect.any(String), inToolCall: false },
        { id: expect.any(String), inToolCall: false },
      ]);
      expect(records[0].id).not.toBe(records[1].id);
    },
    TIMEOUT,
  );
});
