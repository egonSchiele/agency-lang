import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as smoltalk from "smoltalk";
import { _registerProviderModule } from "./llm.js";
import { __resetLoadedProviderModules } from "../runtime/providerModules.js";

const here = import.meta.dirname;
const tmp: string[] = [];
afterEach(() => {
  for (const p of tmp.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  smoltalk.unregisterProvider("rpm-test");
  __resetLoadedProviderModules();
});

describe("_registerProviderModule", () => {
  it("loads a module by path and registers its provider", async () => {
    const p = path.join(here, "__tmp_rpm.mjs");
    fs.writeFileSync(
      p,
      `import { BaseClient } from "smoltalk";
      class RPM extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
      export function register({ registerProvider }) { registerProvider("rpm-test", RPM); }`,
    );
    tmp.push(p);
    await _registerProviderModule(p);
    expect(smoltalk.getClient({ model: "m", provider: "rpm-test" }).constructor.name).toBe("RPM");
  });

  it("refuses a symlink at the module path and loads nothing", async () => {
    const target = path.join(here, "__tmp_rpm_target.mjs");
    fs.writeFileSync(
      target,
      `export function register({ registerProvider }) { registerProvider("rpm-test", class {}); }`,
    );
    const link = path.join(here, "__tmp_rpm_link.mjs");
    fs.symlinkSync(target, link);
    tmp.push(target, link);
    await expect(_registerProviderModule(link)).rejects.toThrow(/symlink/);
    expect(() => smoltalk.getClient({ model: "m", provider: "rpm-test" })).toThrow();
  });
});
