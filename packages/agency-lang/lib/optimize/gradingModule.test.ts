import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgencyConfig } from "@/config.js";
import { BaseGrader } from "./grading/baseGrader.js";
import { loadGradingModule } from "./gradingModule.js";

const cfg: AgencyConfig = {};

describe("loadGradingModule", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (name: string, src: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, src);
    return p;
  };

  it("loads a default-exported metric function as one grader", async () => {
    const file = write("grading.ts", `export default ({ output }: any) => (output === "Paris" ? 1 : 0);`);
    const graders = await loadGradingModule(file, cfg);
    expect(graders).toHaveLength(1);
    expect(graders[0]).toBeInstanceOf(BaseGrader);
  });

  it("loads a default-exported array of graders", async () => {
    const file = write("grading.ts", `
      const a = ({ output }: any) => output === "x";
      const b = ({ output }: any) => 0.5;
      export default [a, b];
    `);
    const graders = await loadGradingModule(file, cfg);
    expect(graders).toHaveLength(2);
  });

  it("throws a clear error when there is no default export", async () => {
    const file = write("grading.ts", `export const notDefault = () => 1;`);
    await expect(loadGradingModule(file, cfg)).rejects.toThrow(/must default-export/);
  });

  it("throws a clear error when an exported entry is not a grader", async () => {
    const file = write("grading.ts", `export default [123];`);
    await expect(loadGradingModule(file, cfg)).rejects.toThrow(/expected a grader function or grader instance/);
  });
});
