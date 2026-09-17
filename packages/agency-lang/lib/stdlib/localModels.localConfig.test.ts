import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  _aliasModel,
  _refreshCatalog,
  defaultAliasTarget,
  readClientConfig,
  readModelAliases,
  resolveAliasConfigPath,
} from "./localModels.js";
import { fileTarget, projectTarget } from "../configTarget.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

const EMPTY_CATALOG = JSON.stringify({ version: 1, models: {} });

let root: string;
let project: string;
let home: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-models-config-")));
  project = path.join(root, "project");
  home = path.join(root, "home");
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  previousCwd = process.cwd();
  previousEnv = {
    HOME: process.env.HOME,
    AGENCY_MODEL_CATALOG_URL: process.env.AGENCY_MODEL_CATALOG_URL,
  };
  process.env.HOME = home;
  delete process.env.AGENCY_MODEL_CATALOG_URL;
  process.chdir(project);
});
afterEach(() => {
  process.chdir(previousCwd);
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  expect(safeDeleteDirectoryWithin(os.tmpdir(), root).success).toBe(true);
});

const write = (file: string, body: unknown) => fs.writeFileSync(file, JSON.stringify(body));
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));
const inProject = (name: string) => path.join(project, name);

describe("defaultAliasTarget", () => {
  it("is the nearest project, even one with only agency.local.json", () => {
    write(inProject("agency.local.json"), {});
    expect(defaultAliasTarget()).toEqual(projectTarget(project));
    expect(resolveAliasConfigPath()).toBe(inProject("agency.json"));
  });

  it("is ~/agency.json alone when there is no project", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    process.chdir(outside);
    write(path.join(home, "agency.json"), { client: { modelsDir: "/home-base" } });
    write(path.join(home, "agency.local.json"), { client: { modelsDir: "/home-local" } });
    expect(defaultAliasTarget()).toEqual(fileTarget(path.join(home, "agency.json")));
    expect(readClientConfig()).toEqual({ modelsDir: "/home-base" });
  });
});

describe("reads merge agency.local.json", () => {
  it("readClientConfig lets the local file win", () => {
    write(inProject("agency.json"), { client: { modelsDir: "/base", mlx: { python: "py" } } });
    write(inProject("agency.local.json"), { client: { modelsDir: "/mine" } });
    expect(readClientConfig()).toEqual({ modelsDir: "/mine", mlx: { python: "py" } });
  });

  it("a local alias replaces the base alias whole, and other aliases stay", () => {
    write(inProject("agency.json"), {
      client: {
        modelAliases: {
          team: "hf:org/team:Q4_K_M",
          coder: { backend: "mlx", uri: "mlx:org/big", source: "remote", sha256: "abc" },
        },
      },
    });
    write(inProject("agency.local.json"), {
      client: { modelAliases: { coder: { backend: "llama-cpp", uri: "hf:org/small:Q4_K_M" } } },
    });
    const aliases = readModelAliases();
    expect(Object.keys(aliases).sort()).toEqual(["coder", "team"]);
    expect(aliases.coder).toEqual({ backend: "llama-cpp", uri: "hf:org/small:Q4_K_M" });
  });

  it("a file target reads that file alone", () => {
    write(inProject("agency.json"), { client: { modelAliases: { team: "hf:org/team:Q4_K_M" } } });
    write(inProject("agency.local.json"), {
      client: { modelAliases: { mine: "hf:org/mine:Q4_K_M" } },
    });
    const aliases = readModelAliases(fileTarget(inProject("agency.json")));
    expect(Object.keys(aliases)).toEqual(["team"]);
  });

  it("names the local file when an alias there is invalid", () => {
    write(inProject("agency.json"), {});
    write(inProject("agency.local.json"), {
      client: { modelAliases: { bad: { uri: "hf:o/r:Q4_K_M" } } },
    });
    expect(() => readModelAliases()).toThrow(/agency\.local\.json/);
  });
});

describe("writes go to agency.json alone", () => {
  it("adding an alias leaves local values out of agency.json", () => {
    write(inProject("agency.json"), { client: {} });
    write(inProject("agency.local.json"), {
      client: { modelsDir: "/mine", modelAliases: { mine: "hf:org/mine:Q4_K_M" } },
    });

    const written = _aliasModel("team", "hf:org/team:Q4_K_M");

    expect(written).toBe(inProject("agency.json"));
    expect(read(inProject("agency.json"))).toEqual({
      client: { modelAliases: { team: "hf:org/team:Q4_K_M" } },
    });
    expect(read(inProject("agency.local.json")).client.modelAliases).toEqual({
      mine: "hf:org/mine:Q4_K_M",
    });
  });

  it("refresh reads the catalog URL from agency.local.json and writes to agency.json", async () => {
    write(inProject("agency.json"), {});
    write(inProject("agency.local.json"), {
      client: { modelCatalogUrl: "https://mine.example/catalog.json" },
    });
    const fetched: string[] = [];

    await _refreshCatalog({
      fetcher: async (url) => {
        fetched.push(url);
        return EMPTY_CATALOG;
      },
    });

    expect(fetched).toEqual(["https://mine.example/catalog.json"]);
    expect(read(inProject("agency.json")).client?.modelCatalogUrl).toBeUndefined();
  });
});
