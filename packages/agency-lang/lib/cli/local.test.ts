import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  aliasAdd,
  aliasList,
  aliasRemove,
  formatRefreshOutput,
  runList,
  runDownload,
  downloadChoices,
  CUSTOM_CHOICE,
} from "./local.js";

let dir: string;
let aliasFile: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")));
  aliasFile = path.join(dir, "agency.json");
  fs.writeFileSync(aliasFile, "{}");
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("agency local CLI helpers", () => {
  it("alias add/list/remove round-trips through agency.json and prints the file", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      aliasAdd("my7b", "hf:org/repo:Q4_K_M", aliasFile);
      expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases.my7b)
        .toBe("hf:org/repo:Q4_K_M");
      expect(log.mock.calls.flat().some((s) => String(s).includes(aliasFile))).toBe(true);

      expect(aliasList(aliasFile).some((m) => m.name === "my7b" && m.source === "alias")).toBe(true);

      aliasRemove("my7b", aliasFile);
      expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases.my7b)
        .toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});

describe("runList", () => {
  it("is ungated: prints the catalog view with no local-model support", () => {
    // The old runList exited 1 without the provider package; this pins the
    // spec's "browsing needs no package". Deterministic in CI (plugin never
    // installed) and still green on dev machines: the new code never
    // consults support at all.
    delete process.env.AGENCY_LLAMA_PROVIDER_MODULE;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit called");
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      runList();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(String(logSpy.mock.calls[0][0])).toMatch(/^Models directory: /);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("downloadChoices", () => {
  it("labels entries with params and size and appends the custom option", () => {
    const choices = downloadChoices([
      { name: "tiny", target: "hf:o/t:Q4", source: "curated", params: "135M", sizeBytes: 100_000_000 },
      { name: "plain-alias", target: "hf:x/y:Q4", source: "alias" },
    ]);
    expect(choices[0]).toEqual({ title: "tiny  (135M, 0.10 GB)", value: "tiny" });
    expect(choices[1]).toEqual({ title: "plain-alias", value: "plain-alias" });
    expect(choices[choices.length - 1].value).toBe(CUSTOM_CHOICE);
  });
});

describe("runDownload without a value, non-TTY", () => {
  it("prints the catalog and the hint, exits 1", async () => {
    // Any non-empty override satisfies the gate; nothing is imported before
    // the TTY check, so the file need not exist.
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = "/nonexistent/fake.mjs";
    const savedIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runDownload(undefined)).rejects.toThrow("exit:1");
      expect(logSpy).toHaveBeenCalled(); // the catalog table
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("agency local download <name>")),
      ).toBe(true);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: savedIsTTY, configurable: true });
      exitSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
      delete process.env.AGENCY_LLAMA_PROVIDER_MODULE;
    }
  });
});

describe("formatRefreshOutput", () => {
  it("renders skip notices (kept + remote) and a summary line", () => {
    const lines = formatRefreshOutput({
      url: "https://x/c.json",
      file: "/tmp/agency.json",
      added: ["a", "b"],
      updated: [],
      unchanged: ["c"],
      removed: ["old"],
      skipped: [{ name: "dupe", keptUri: "hf:mine:Q4_K_M", remoteUri: "hf:remote:Q4_K_M" }],
      modelCount: 4, // a, b, c, dupe (= added + updated + unchanged + skipped)
    });
    expect(lines[0]).toBe('Skipped "dupe": kept your alias (hf:mine:Q4_K_M);');
    expect(lines[1]).toBe("  remote would have set hf:remote:Q4_K_M");
    // Summary mentions total catalog size, then breakdown.
    expect(lines.some((l) => l.includes("4 models from https://x/c.json"))).toBe(true);
    expect(
      lines.some((l) => l.includes("2 added, 0 updated, 1 unchanged, 1 removed, 1 skipped")),
    ).toBe(true);
  });
});
