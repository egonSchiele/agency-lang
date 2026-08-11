import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import * as smoltalkPkg from "smoltalk";
import {
  loadLocalProvider,
  chooseEntryPath,
  ensureConfiguredLocalProvider,
  resolveSmoltalkLlamaCppFromRoots,
} from "./localProvider.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const fakes: string[] = [];
let fakeCounter = 0;

/** Plugin-shaped fake: what smoltalk's loadLlamaCpp validates and registers.
 *  Unique filename per call — a reused path would be served from the ESM
 *  module cache, silently handing later tests the first module. Tracked in
 *  `fakes` for cleanup. */
function writeFakePlugin(): string {
  const p = path.join(here, `__tmp_fake_plugin_${process.pid}_${fakeCounter++}.mjs`);
  fs.writeFileSync(
    p,
    `import { BaseClient } from "smoltalk";
export class LlamaCPP extends BaseClient {
  async textSync() { return { success: true, value: { output: "local-ok", toolCalls: [] } }; }
}
export async function resolveModel(target, dir) { return "RESOLVED:" + target; }
`,
  );
  fakes.push(p);
  return p;
}

// File-level cleanup so every describe in this file gets it.
afterEach(() => {
  delete process.env.AGENCY_LLAMA_PROVIDER_MODULE;
  smoltalkPkg.unregisterProvider("llama-cpp");
  for (const p of fakes.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
});

describe("chooseEntryPath", () => {
  it("override wins and a relative override is absolutized against cwd", () => {
    expect(
      chooseEntryPath({
        override: "/abs/fake.mjs",
        cwd: "/w",
        localEntry: "/l/e.js",
        globalEntry: () => "/g/e.js",
      }),
    ).toBe("/abs/fake.mjs");
    expect(
      chooseEntryPath({
        override: "rel/fake.mjs",
        cwd: "/w",
        localEntry: null,
        globalEntry: () => null,
      }),
    ).toBe(path.resolve("/w", "rel/fake.mjs"));
  });

  it("locally resolvable → undefined (smoltalk bare import owns it) and the global probe is not run", () => {
    expect(
      chooseEntryPath({
        override: undefined,
        cwd: "/w",
        localEntry: "/l/e.js",
        globalEntry: () => {
          throw new Error("must not probe global roots");
        },
      }),
    ).toBeUndefined();
  });

  it("global-only install → the probed path", () => {
    expect(
      chooseEntryPath({
        override: undefined,
        cwd: "/w",
        localEntry: null,
        globalEntry: () => "/g/e.js",
      }),
    ).toBe("/g/e.js");
  });

  it("nothing found → undefined (smoltalk raises its install hint)", () => {
    expect(
      chooseEntryPath({
        override: undefined,
        cwd: "/w",
        localEntry: null,
        globalEntry: () => null,
      }),
    ).toBeUndefined();
  });
});

describe("loadLocalProvider", () => {
  it("honors AGENCY_LLAMA_PROVIDER_MODULE and registers the provider", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = writeFakePlugin();
    const mod = await loadLocalProvider();
    expect(typeof mod.resolveModel).toBe("function");
    const client = smoltalkPkg.getClient({
      model: "m",
      provider: "llama-cpp",
      messages: [],
    });
    expect(client.constructor.name).toBe("LlamaCPP");
  });

  it("relativizes a relative override against cwd", async () => {
    const abs = writeFakePlugin();
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = path.relative(process.cwd(), abs);
    const mod = await loadLocalProvider();
    expect(typeof mod.resolveModel).toBe("function");
  });
});

// Env/registry/fake-file cleanup comes from the file-level afterEach above.
describe("ensureConfiguredLocalProvider", () => {
  it("is a no-op when the config does not name llama-cpp", async () => {
    // No env override, no package: would throw if it tried to load.
    await ensureConfiguredLocalProvider({ smoltalkDefaults: { provider: "openai" } });
    await ensureConfiguredLocalProvider({ smoltalkDefaults: {} });
    await ensureConfiguredLocalProvider({});
  });

  it("loads the provider when the config names llama-cpp", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = writeFakePlugin();
    await ensureConfiguredLocalProvider({ smoltalkDefaults: { provider: "llama-cpp" } });
    const client = smoltalkPkg.getClient({
      model: "m",
      provider: "llama-cpp",
      messages: [],
    });
    expect(client.constructor.name).toBe("LlamaCPP");
  });
});

// Helper: each global `node_modules` root must literally be a directory
// named `node_modules` (the convention `npm root -g` / `pnpm root -g` uses
// — `/opt/homebrew/lib/node_modules`, `~/Library/pnpm/global/5/node_modules`).
// The resolver walks UP from `<root>/..` looking for a `node_modules` sibling,
// which is the root itself.
function makeFakeGlobalRoot(parent: string, name: string): string {
  const root = path.join(parent, name, "node_modules");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function plantFakePackage(root: string, packageName: string): string {
  const pkgDir = path.join(root, packageName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: packageName, version: "0.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};");
  return path.join(pkgDir, "index.js");
}

describe("resolveSmoltalkLlamaCppFromRoots (global-install discovery)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lp-")));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds the package in a synthetic global node_modules root", () => {
    const root = makeFakeGlobalRoot(dir, "fake-global");
    const entry = plantFakePackage(root, "smoltalk-llama-cpp");
    expect(resolveSmoltalkLlamaCppFromRoots([root])).toBe(entry);
  });
  it("returns null when no root contains the package", () => {
    const empty = makeFakeGlobalRoot(dir, "empty-global");
    expect(resolveSmoltalkLlamaCppFromRoots([empty])).toBeNull();
  });
  it("tries roots in order and returns the first hit", () => {
    const rootA = makeFakeGlobalRoot(dir, "g-a");
    const rootB = makeFakeGlobalRoot(dir, "g-b");
    const entryB = plantFakePackage(rootB, "smoltalk-llama-cpp");
    expect(resolveSmoltalkLlamaCppFromRoots([rootA, rootB])).toBe(entryB);
  });
});
