import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as smoltalk from "smoltalk";
import {
  loadProviderModules,
  __resetLoadedProviderModules,
} from "./providerModules.js";

// Temp provider-module fixtures are written next to this test file so their
// bare `import "smoltalk"` resolves against the package's node_modules.
const here = import.meta.dirname;
const tmpFiles: string[] = [];

function writeModule(name: string, body: string): string {
  const p = path.join(here, `__tmp_provider_${name}.mjs`);
  fs.writeFileSync(p, body);
  tmpFiles.push(p);
  return p;
}

beforeEach(() => {
  __resetLoadedProviderModules();
  delete process.env.AGENCY_PROVIDER_MODULES;
  globalThis.__providerRegisterCount = 0;
});

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try { fs.unlinkSync(p); } catch { }
  }
  for (const name of ["echo-a", "count-a"]) {
    smoltalk.unregisterProvider(name);
  }
  delete process.env.AGENCY_PROVIDER_MODULES;
});

describe("loadProviderModules", () => {
  it("registers a provider from a configured module path", async () => {
    const mod = writeModule(
      "echo",
      `import { BaseClient } from "smoltalk";
       class EchoA extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
       export function register({ registerProvider }) { registerProvider("echo-a", EchoA); }`,
    );
    await loadProviderModules({ providerModules: [mod] });
    const client = smoltalk.getClient({ model: "m", provider: "echo-a" });
    expect(client.constructor.name).toBe("EchoA");
  });

  it("reads paths from the AGENCY_PROVIDER_MODULES env var too", async () => {
    const mod = writeModule(
      "echo",
      `import { BaseClient } from "smoltalk";
       class EchoA extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
       export function register({ registerProvider }) { registerProvider("echo-a", EchoA); }`,
    );
    process.env.AGENCY_PROVIDER_MODULES = mod;
    await loadProviderModules({ providerModules: [] });
    expect(smoltalk.getClient({ model: "m", provider: "echo-a" }).constructor.name).toBe("EchoA");
  });

  it("registers each module only once per process (loaded-Set guard)", async () => {
    const mod = writeModule(
      "count",
      `import { BaseClient } from "smoltalk";
       class CountA extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
       export function register({ registerProvider }) {
         globalThis.__providerRegisterCount = (globalThis.__providerRegisterCount ?? 0) + 1;
         registerProvider("count-a", CountA);
       }`,
    );
    await loadProviderModules({ providerModules: [mod] });
    await loadProviderModules({ providerModules: [mod] });
    expect(globalThis.__providerRegisterCount).toBe(1);
  });

  it("throws a clear error when the module path does not resolve", async () => {
    await expect(
      loadProviderModules({ providerModules: ["./does-not-exist-xyz.mjs"] }),
    ).rejects.toThrow(/Failed to load provider module/);
  });

  it("throws when the module has no register export", async () => {
    const mod = writeModule("noreg", `export const nope = 1;`);
    await expect(
      loadProviderModules({ providerModules: [mod] }),
    ).rejects.toThrow(/does not export a "register" function/);
  });

  it("throws when register() itself throws", async () => {
    const mod = writeModule(
      "boom",
      `export function register() { throw new Error("kaboom"); }`,
    );
    await expect(
      loadProviderModules({ providerModules: [mod] }),
    ).rejects.toThrow(/threw during register\(\): kaboom/);
  });
});
