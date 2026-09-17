import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgencyConfigSchema } from "./config.js";
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  configFiles,
  configTarget,
  fileTarget,
  findProjectRoot,
  hasProjectConfig,
  projectTarget,
  readConfig,
  targetPaths,
  writeTarget,
} from "./configTarget.js";
import { safeDeleteDirectoryWithin } from "./utils.js";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agency-config-target-")));
});
afterEach(() => {
  expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
});

const inDir = (name: string) => path.join(dir, name);
const write = (name: string, body: unknown) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  fs.writeFileSync(inDir(name), text);
};

describe("targets", () => {
  it("configTarget uses the -c file when given, and the fallback otherwise", () => {
    const fallback = projectTarget(dir);
    expect(configTarget("team.json", fallback)).toEqual(fileTarget("team.json"));
    expect(configTarget(undefined, fallback)).toBe(fallback);
  });

  it("targetPaths lists every candidate, and configFiles the ones that exist", () => {
    write(LOCAL_CONFIG_FILE, {});
    expect(targetPaths(projectTarget(dir))).toEqual([
      inDir(CONFIG_FILE),
      inDir(LOCAL_CONFIG_FILE),
    ]);
    expect(configFiles(projectTarget(dir))).toEqual([inDir(LOCAL_CONFIG_FILE)]);
    expect(configFiles(fileTarget(inDir("missing.json")))).toEqual([]);
    expect(hasProjectConfig(dir)).toBe(true);
  });

  it("writeTarget is the named file, or the project's agency.json", () => {
    expect(writeTarget(fileTarget(inDir("team.json")))).toBe(inDir("team.json"));
    expect(writeTarget(projectTarget(dir))).toBe(inDir(CONFIG_FILE));
  });
});

describe("readConfig", () => {
  it("returns an empty config when no file exists", () => {
    expect(readConfig(projectTarget(dir))).toEqual({ config: {} });
    expect(hasProjectConfig(dir)).toBe(false);
  });

  it("reads a named file alone, even with a local file beside it", () => {
    write(CONFIG_FILE, { outDir: "base" });
    write(LOCAL_CONFIG_FILE, { outDir: "local" });
    expect(readConfig(fileTarget(inDir(CONFIG_FILE)))).toEqual({ config: { outDir: "base" } });
  });

  it("reads agency.local.json alone", () => {
    write(LOCAL_CONFIG_FILE, { outDir: "mine" });
    expect(readConfig(projectTarget(dir))).toEqual({ config: { outDir: "mine" } });
  });

  it("merges the local file over the base file", () => {
    write(CONFIG_FILE, {
      outDir: "dist",
      log: { host: "https://h", projectId: "team" },
      coverage: { exclude: ["a/**", "b/**"] },
      mcpServers: { search: { type: "http", url: "https://s/mcp" }, fs: { command: "npx" } },
    });
    write(LOCAL_CONFIG_FILE, {
      outDir: "mine",
      log: { projectId: "me" },
      coverage: { exclude: ["c/**"] },
      mcpServers: { search: { command: "node" } },
    });
    expect(readConfig(projectTarget(dir)).config).toEqual({
      outDir: "mine",
      log: { host: "https://h", projectId: "me" },
      coverage: { exclude: ["c/**"] },
      mcpServers: { search: { command: "node" }, fs: { command: "npx" } },
    });
  });

  it("returns keys in schema order, whichever file they came from", () => {
    write(CONFIG_FILE, { outDir: "x" });
    write(LOCAL_CONFIG_FILE, { verbose: false });
    const split = readConfig(projectTarget(dir)).config;
    const single = AgencyConfigSchema.parse({ verbose: false, outDir: "x" });
    expect(JSON.stringify(split)).toBe(JSON.stringify(single));
  });

  it.each([
    ["not valid JSON", "{ not json"],
    ["failing the schema", { maxToolCallRounds: "many" }],
  ])("names the local file when it is %s", (_label, body) => {
    write(CONFIG_FILE, {});
    write(LOCAL_CONFIG_FILE, body);
    expect(readConfig(projectTarget(dir)).error).toContain(inDir(LOCAL_CONFIG_FILE));
  });

  it("names the base file when it fails the schema", () => {
    write(CONFIG_FILE, { maxToolCallRounds: "many" });
    expect(readConfig(projectTarget(dir)).error).toContain(inDir(CONFIG_FILE));
  });

  it("drops __proto__ keys from either file", () => {
    write(CONFIG_FILE, '{"__proto__": {"polluted": true}, "outDir": "a"}');
    write(LOCAL_CONFIG_FILE, '{"__proto__": {"polluted": true}}');
    const { config } = readConfig(projectTarget(dir));
    expect(Object.keys(config)).toEqual(["outDir"]);
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("findProjectRoot", () => {
  it("finds a directory that has only agency.local.json", () => {
    write(LOCAL_CONFIG_FILE, "{}");
    const child = inDir("src");
    fs.mkdirSync(child);
    expect(findProjectRoot(child)).toBe(dir);
  });
});
