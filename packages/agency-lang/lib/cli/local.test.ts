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
  runResolve,
  runRemove,
  runDownload,
  printDownloadEvent,
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
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agency local CLI helpers", () => {
  it("alias add/list/remove round-trips through agency.json and prints the file", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      aliasAdd("my7b", "hf:org/repo:Q4_K_M", aliasFile);
      expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases.my7b).toBe(
        "hf:org/repo:Q4_K_M",
      );
      expect(log.mock.calls.flat().some((s) => String(s).includes(aliasFile))).toBe(true);

      expect(aliasList(aliasFile).some((m) => m.name === "my7b" && m.source === "alias")).toBe(
        true,
      );

      aliasRemove("my7b", aliasFile);
      expect(
        JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases.my7b,
      ).toBeUndefined();
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
      {
        name: "tiny",
        backend: "llama-cpp",
        target: "hf:o/t:Q4",
        source: "curated",
        params: "135M",
        sizeBytes: 100_000_000,
      },
      { name: "plain-alias", backend: "llama-cpp", target: "hf:x/y:Q4", source: "alias" },
    ]);
    expect(choices[0]).toEqual({ title: "tiny  (135M, 0.10 GB)", value: "tiny" });
    expect(choices[1]).toEqual({ title: "plain-alias", value: "plain-alias" });
    expect(choices[choices.length - 1].value).toBe(CUSTOM_CHOICE);
  });
});

describe("runDownload without a value, non-interactive", () => {
  it("does not need smoltalk-llama-cpp before the user has picked a model", async () => {
    // No override and no package: the non-interactive path must still print
    // the catalog and the hint rather than the install message.
    delete process.env.AGENCY_LLAMA_PROVIDER_MODULE;
    const savedIn = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runDownload(undefined)).rejects.toThrow("exit:1");
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("smoltalk-llama-cpp"))).toBe(
        false,
      );
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("agency local download <name>")),
      ).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: savedIn, configurable: true });
      exitSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  /** Run runDownload(undefined) with the given TTY shape; expect the
   *  non-interactive path: catalog + hint + exit 1. */
  async function expectNonInteractive(stdinTTY: boolean, stdoutTTY: boolean) {
    // Any non-empty override satisfies the gate; nothing is imported before
    // the TTY check, so the file need not exist.
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = "/nonexistent/fake.mjs";
    const savedIn = process.stdin.isTTY;
    const savedOut = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: stdinTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutTTY, configurable: true });
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
      Object.defineProperty(process.stdin, "isTTY", { value: savedIn, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: savedOut, configurable: true });
      exitSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
      delete process.env.AGENCY_LLAMA_PROVIDER_MODULE;
    }
  }

  it("non-TTY stdout: prints the catalog and the hint, exits 1", async () => {
    await expectNonInteractive(false, false);
  });

  it("TTY stdout but piped stdin (download < /dev/null from a terminal): same non-interactive path", async () => {
    await expectNonInteractive(false, true);
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

describe("runResolve", () => {
  it("prints the backend and the target", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      runResolve("smollm2-135m");
      expect(log).toHaveBeenCalledWith("llama-cpp  hf:unsloth/SmolLM2-135M-Instruct-GGUF:Q4_K_M");
      runResolve("mlx:mlx-community/Qwen3-Coder-Next-4bit");
      expect(log).toHaveBeenCalledWith("mlx  mlx:mlx-community/Qwen3-Coder-Next-4bit");
    } finally {
      log.mockRestore();
    }
  });
});

describe("runRemove", () => {
  let cwd: string;
  let models: string;
  let gguf: string;
  let output: string[];
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    cwd = process.cwd();
    process.chdir(dir);
    models = path.join(dir, "models");
    fs.mkdirSync(models);
    gguf = path.join(models, "coder.gguf");
    fs.writeFileSync(gguf, "xxxx");
    fs.writeFileSync(
      path.join(models, "downloads.json"),
      JSON.stringify({ "hf:org/coder:Q4_K_M": "coder.gguf" }),
    );
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { coder: "hf:org/coder:Q4_K_M" } } }),
    );
    process.env.AGENCY_MODELS_DIR = models;
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = "/nonexistent/fake.mjs";
    output = [];
    log = vi.spyOn(console, "log").mockImplementation((line: string) => {
      output.push(line);
    });
  });
  afterEach(() => {
    log.mockRestore();
    delete process.env.AGENCY_MODELS_DIR;
    delete process.env.AGENCY_LLAMA_PROVIDER_MODULE;
    process.chdir(cwd);
  });

  it("without -f removes the alias, keeps the files, and says how to delete them", () => {
    runRemove("coder", { force: false });
    expect(output[0]).toBe(`Removed alias "coder" from ${aliasFile}.`);
    expect(output[1]).toBe(`The model files are still at ${gguf} (0.00 GB).`);
    expect(output[2]).toBe("Run again with -f to delete them.");
    expect(fs.existsSync(gguf)).toBe(true);
    expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases).toEqual({});
  });

  it("with -f deletes the files", () => {
    runRemove("coder", { force: true });
    expect(output[0]).toBe(`Removed alias "coder" from ${aliasFile}.`);
    expect(output[1]).toBe(`Deleted ${gguf} (0.00 GB)`);
    expect(fs.existsSync(gguf)).toBe(false);
  });

  it("a curated name without -f says there is no alias and where the file is", () => {
    runRemove("smollm2-135m", { force: false });
    expect(output[0]).toBe(
      '"smollm2-135m" is a built-in catalog entry, so there is no alias to remove.',
    );
    expect(output.length).toBe(1);
  });

  it("with -f deletes an mlx model directory under the cache", () => {
    const model = path.join(models, "mlx", "org--repo");
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "xx");
    fs.writeFileSync(
      path.join(model, ".agency-model.json"),
      JSON.stringify({ repo: "org/repo", revision: "a", files: {} }),
    );
    runRemove("mlx:org/repo", { force: true });
    expect(output[0]).toMatch(/^Deleted .*org--repo/);
    expect(fs.existsSync(model)).toBe(false);
  });

  it("with -f removes the alias as well as the files", () => {
    runRemove("coder", { force: true });
    expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases).toEqual({});
    expect(fs.existsSync(gguf)).toBe(false);
  });

  it("removes an alias whose directory has gone", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { gone: path.join(dir, "vanished") } } }),
    );
    runRemove("gone", { force: false });
    expect(output[0]).toBe(`Removed alias "gone" from ${aliasFile}.`);
    expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases).toEqual({});
  });

  it("without -f, an alias to a directory outside the cache says to delete it yourself", () => {
    const outside = path.join(dir, "elsewhere");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "config.json"), "{}");
    fs.writeFileSync(path.join(outside, "model.safetensors"), "xx");
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { modelAliases: { ext: outside } } }));
    runRemove("ext", { force: false });
    expect(output[0]).toBe(`Removed alias "ext" from ${aliasFile}.`);
    expect(output[1]).toContain("outside the models directory, so delete them yourself");
    expect(output.some((l) => l.includes("-f"))).toBe(false);
  });

  it("refuses to delete a model directory outside the cache", () => {
    const outside = path.join(dir, "elsewhere");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "config.json"), "{}");
    fs.writeFileSync(path.join(outside, "model.safetensors"), "xx");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit called");
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => runRemove(outside, { force: true })).toThrow("exit called");
      expect(err).toHaveBeenCalledWith(
        "That model is not in the models directory; remove it yourself.",
      );
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      exitSpy.mockRestore();
      err.mockRestore();
    }
  });
});

describe("printDownloadEvent", () => {
  it("prints a line per file, a rewritten counter on a TTY, and the verify lines", () => {
    const out: string[] = [];
    let clock = 0;
    const print = printDownloadEvent(
      true,
      (s) => out.push(s),
      () => clock,
    );
    print({ kind: "file-start", path: "a.safetensors", size: 5e9, resumedBytes: 0 });
    print({ kind: "bytes", done: 1e9, total: 5e9 });
    clock = 2000;
    print({ kind: "bytes", done: 2e9, total: 5e9 });
    print({ kind: "file-done", path: "a.safetensors" });
    print({ kind: "verify", path: "a.safetensors", ok: true });
    print({ kind: "file-start", path: "b.safetensors", size: 3e9, resumedBytes: 1e9 });
    expect(out).toEqual([
      "a.safetensors  5.00 GB\n",
      "\r\x1b[2K  1.00 GB / 5.00 GB  20%",
      "\r\x1b[2K  2.00 GB / 5.00 GB  40%  500.0 MB/s  6s left",
      "\n",
      "  verified a.safetensors\n",
      "b.safetensors  3.00 GB  (resuming from 1.00 GB)\n",
    ]);
  });

  it("ends the counter line itself when the last byte lands", () => {
    const out: string[] = [];
    const print = printDownloadEvent(true, (s) => out.push(s));
    print({ kind: "bytes", done: 1, total: 2 });
    print({ kind: "bytes", done: 2, total: 2 });
    print({ kind: "verify", path: "a", ok: true });
    expect(out).toEqual([
      "\r\x1b[2K  0.00 GB / 0.00 GB  50%",
      "\r\x1b[2K  0.00 GB / 0.00 GB  100%",
      "\n",
      "  verified a\n",
    ]);
  });

  it("quotes a file path that could move the cursor", () => {
    const out: string[] = [];
    const print = printDownloadEvent(false, (s) => out.push(s));
    print({ kind: "verify", path: "a\x1b[2Jb\nforged", ok: true });
    expect(out).toEqual(['  verified "a\\u001b[2Jb\\nforged"\n']);
  });

  it("off a TTY prints a line at each tenth percent and nothing in between", () => {
    const out: string[] = [];
    const print = printDownloadEvent(false, (s) => out.push(s));
    print({ kind: "bytes", done: 1, total: 20 });
    print({ kind: "bytes", done: 2, total: 20 });
    print({ kind: "bytes", done: 3, total: 20 });
    print({ kind: "bytes", done: 20, total: 20 });
    print({ kind: "verify", path: "a", ok: false });
    expect(out).toEqual([
      "  0.00 GB / 0.00 GB  5%\n",
      "  0.00 GB / 0.00 GB  10%\n",
      "  0.00 GB / 0.00 GB  100%\n",
      "  a failed verification\n",
    ]);
  });
});
