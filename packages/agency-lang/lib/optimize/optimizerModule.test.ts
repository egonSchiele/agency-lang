import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOptimizerModule } from "./optimizerModule.js";

describe("loadOptimizerModule", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (src: string): string => {
    const p = path.join(dir, "opt.ts");
    fs.writeFileSync(p, src);
    return p;
  };

  it("returns the default-exported factory function", async () => {
    const file = write(`export default (config: any) => ({ name: "mine", optimize: async () => ({}) });`);
    const factory = await loadOptimizerModule(file);
    expect(typeof factory).toBe("function");
    const opt = factory({} as any);
    expect(opt.name).toBe("mine");
  });

  it("throws when there is no default export", async () => {
    const file = write(`export const notDefault = 1;`);
    await expect(loadOptimizerModule(file)).rejects.toThrow(/must default-export/);
  });

  it("throws when the default export is not a function", async () => {
    const file = write(`export default { name: "mine" };`);
    await expect(loadOptimizerModule(file)).rejects.toThrow(/must default-export a factory function/);
  });
});
