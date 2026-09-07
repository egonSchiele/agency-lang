import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import {
  serveArgs,
  choosePython,
  memoryWarning,
  notServedMessage,
  pythonMissingMessage,
  waitUntilLoaded,
  checkPython,
  freePort,
  formatElapsed,
  servingBanner,
  runServe,
  type ServeDeps,
  type Child,
} from "./localServe.js";

describe("serveArgs", () => {
  it("builds the mlx_lm.server command line", () => {
    expect(serveArgs("/models/mlx/org--repo", 8081, 16384)).toEqual([
      "-m",
      "mlx_lm.server",
      "--model",
      "/models/mlx/org--repo",
      "--host",
      "127.0.0.1",
      "--port",
      "8081",
      "--max-tokens",
      "16384",
      "--log-level",
      "INFO",
    ]);
  });
});

describe("choosePython", () => {
  it("flag, then config, then env, then the default env", () => {
    expect(choosePython("/a/python", "/b/python", "/c/python", "/home")).toBe("/a/python");
    expect(choosePython(undefined, "/b/python", "/c/python", "/home")).toBe("/b/python");
    expect(choosePython(undefined, undefined, "/c/python", "/home")).toBe("/c/python");
    expect(choosePython(undefined, undefined, undefined, "/home")).toBe(
      "/home/.agency-agent/mlx-env/bin/python",
    );
  });

  it("treats an empty config or env value as unset", () => {
    expect(choosePython(undefined, "", "", "/home")).toBe("/home/.agency-agent/mlx-env/bin/python");
  });
});

describe("memoryWarning", () => {
  it("warns when the models do not fit, in GB", () => {
    expect(memoryWarning([150e9, 46.4e9], 64e9)).toBe(
      "Warning: these models total 196.4 GB and this machine has 64.0 GB of memory.",
    );
  });

  it("is silent when they fit", () => {
    expect(memoryWarning([44.9e9], 64e9)).toBeNull();
  });
});

describe("messages", () => {
  it("notServedMessage names the served models and the command", () => {
    expect(notServedMessage(["a/one", "a/two"], "a/three")).toBe(
      "This server is serving a/one and a/two. It is not serving a/three. Start it with: agency local serve mlx:a/three",
    );
    expect(notServedMessage(["a/one"], "a/three")).toBe(
      "This server is serving a/one. It is not serving a/three. Start it with: agency local serve mlx:a/three",
    );
    expect(notServedMessage(["a/one", "a/two", "a/four"], "/m/dir")).toBe(
      "This server is serving a/one, a/two and a/four. It is not serving /m/dir. Start it with: agency local serve /m/dir",
    );
  });

  it("pythonMissingMessage shows the venv commands for the default environment", () => {
    const msg = pythonMissingMessage("/usr/bin/python3", "/home/me");
    expect(msg).toContain("/usr/bin/python3 cannot import mlx_lm.");
    expect(msg).toContain("python3.12 -m venv /home/me/.agency-agent/mlx-env");
    expect(msg).toContain("/home/me/.agency-agent/mlx-env/bin/pip install mlx-lm");
    expect(msg).toContain("point --python at a Python that has");
  });
});

describe("waitUntilLoaded", () => {
  it("sends a one-token completion naming the model and resolves when it answers", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await waitUntilLoaded(8081, "/m/dir", { fetch: fetchFn });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8081/v1/chat/completions",
        body: { model: "/m/dir", messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
      },
    ]);
  });

  it("retries while the port is not open yet, then resolves", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      if (n < 3) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await waitUntilLoaded(8081, "/m/dir", { fetch: fetchFn, retryMs: 1 });
    expect(n).toBe(3);
  });

  it("stops retrying when told the process is gone", async () => {
    let n = 0;
    const gone = new Promise<string>((resolve) =>
      setTimeout(() => resolve("mlx_lm.server for /m/dir exited with 1"), 15),
    );
    const fetchFn = (async () => {
      n += 1;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      waitUntilLoaded(8081, "/m/dir", { fetch: fetchFn, retryMs: 1, gone }),
    ).rejects.toThrow("mlx_lm.server for /m/dir exited with 1 before it was ready.");
    const after = n;
    await new Promise((r) => setTimeout(r, 10));
    expect(n).toBe(after);
  });
});

describe("checkPython", () => {
  it("passes when `python -c import mlx_lm` exits 0", () => {
    const seen: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      seen.push([cmd, ...args]);
      return { status: 0 };
    };
    expect(checkPython("/x/python", exec)).toBe(true);
    expect(seen).toEqual([["/x/python", "-c", "import mlx_lm"]]);
    expect(checkPython("/x/python", () => ({ status: 1 }))).toBe(false);
    expect(checkPython("/x/python", () => ({ status: null }))).toBe(false);
  });
});

describe("freePort", () => {
  it("returns a port nothing is listening on", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const again = await freePort();
    expect(again).toBeGreaterThan(0);
  });
});

describe("formatElapsed", () => {
  it("prints seconds, then minutes and seconds", () => {
    expect(formatElapsed(48_400)).toBe("48s");
    expect(formatElapsed(134_000)).toBe("2m 14s");
  });
});

describe("servingBanner", () => {
  it("lists the models and shows the run and agent commands", () => {
    expect(servingBanner(8080, ["org/a", "/m/dir"])).toEqual([
      "Serving 2 models on http://127.0.0.1:8080/v1:",
      "  org/a",
      "  /m/dir",
      "",
      "  agency run --local mlx:org/a your.agency",
      "  agency agent --local mlx:org/a",
    ]);
    expect(servingBanner(8080, ["/m/dir"])[0]).toBe("Serving 1 model on http://127.0.0.1:8080/v1:");
    expect(servingBanner(8080, ["/m/dir"])[3]).toBe("  agency run --local /m/dir your.agency");
  });
});

describe("runServe", () => {
  let dir: string;
  let cacheDir: string;
  let spawned: string[][];
  let killed: number;
  let log: string[];
  let deps: ServeDeps;

  /** A downloaded model under <cacheDir>/mlx with a complete record. */
  function recordedModel(repo: string, complete: boolean): string {
    const model = path.join(cacheDir, "mlx", repo.replace("/", "--"));
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "xxxxxxxx");
    fs.writeFileSync(
      path.join(model, ".agency-model.json"),
      JSON.stringify({
        repo,
        revision: "abc",
        files: {
          "config.json": { size: 2, complete: true },
          "model.safetensors": { size: 600e6, complete },
        },
      }),
    );
    return model;
  }

  function fakeChild(): Child & { exit: (code: number | null) => void } {
    const listeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    return {
      on: (_ev, cb) => listeners.push(cb),
      kill: () => {
        killed += 1;
      },
      exit: (code) => listeners.forEach((cb) => cb(code, null)),
    };
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "serve-")));
    cacheDir = path.join(dir, "models");
    spawned = [];
    killed = 0;
    log = [];
    let next = 9000;
    deps = {
      spawn: (python, args) => {
        spawned.push([python, ...args]);
        return fakeChild();
      },
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      exec: () => ({ status: 0 }),
      totalmem: () => 1e9,
      log: (line) => log.push(line),
      freePort: async () => next++,
      cacheDir,
      home: "/home/me",
      env: {},
      configuredPython: undefined,
    };
  });

  afterEach(() => {
    safeDeleteDirectoryWithin(os.tmpdir(), dir);
  });

  it("resolves, warns, starts one process per model, waits, then opens the door", async () => {
    const a = recordedModel("org/a", true);
    const b = recordedModel("org/b", true);
    const handle = await runServe(["mlx:org/a", "mlx:org/b"], { port: 0 }, deps);
    expect(spawned).toEqual([
      [
        "/home/me/.agency-agent/mlx-env/bin/python",
        "-m",
        "mlx_lm.server",
        "--model",
        a,
        "--host",
        "127.0.0.1",
        "--port",
        "9000",
        "--max-tokens",
        "16384",
        "--log-level",
        "INFO",
      ],
      [
        "/home/me/.agency-agent/mlx-env/bin/python",
        "-m",
        "mlx_lm.server",
        "--model",
        b,
        "--host",
        "127.0.0.1",
        "--port",
        "9001",
        "--max-tokens",
        "16384",
        "--log-level",
        "INFO",
      ],
    ]);
    expect(log[0]).toBe(
      "Warning: these models total 1.2 GB and this machine has 1.0 GB of memory.",
    );
    expect(log[1]).toBe("Loading org/a (0.6 GB)…");
    expect(log[2]).toMatch(/^ {2}ready in \d+s$/);
    expect(log[5]).toBe(`Serving 2 models on http://127.0.0.1:${handle.port}/v1:`);
    expect(handle.models).toEqual(["org/a", "org/b"]);
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/models`);
    expect((await res.json()).data.map((m: { id: string }) => m.id)).toEqual(["org/a", "org/b"]);
    await handle.close();
    expect(killed).toBe(2);
  });

  it("serves a model directory under the name run --local sends", async () => {
    const model = path.join(dir, "snapshot");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "");
    const handle = await runServe(
      [model],
      { port: 0, maxTokens: 4096, python: "/my/python" },
      deps,
    );
    expect(spawned[0]).toContain("/my/python");
    expect(spawned[0]).toContain("4096");
    expect(handle.models).toEqual([model]);
    expect(log.some((l) => l.startsWith("Warning"))).toBe(false);
    await handle.close();
  });

  it("refuses a GGUF model", async () => {
    await expect(runServe(["smollm2-135m"], {}, deps)).rejects.toThrow(
      '"smollm2-135m" is a GGUF model. agency local serve is for MLX models; run it with agency run --local smollm2-135m instead.',
    );
  });

  it("refuses a model that is not downloaded, or only partly", async () => {
    await expect(runServe(["mlx:org/missing"], {}, deps)).rejects.toThrow(
      "org/missing is not downloaded. Run:\n  agency local download mlx:org/missing",
    );
    recordedModel("org/half", false);
    await expect(runServe(["mlx:org/half"], {}, deps)).rejects.toThrow(
      "org/half is not downloaded. Run:\n  agency local download mlx:org/half",
    );
    expect(spawned).toEqual([]);
  });

  it("refuses a Python without mlx_lm, before starting anything", async () => {
    recordedModel("org/a", true);
    await expect(
      runServe(["mlx:org/a"], {}, { ...deps, exec: () => ({ status: 1 }) }),
    ).rejects.toThrow(/cannot import mlx_lm/);
    expect(spawned).toEqual([]);
  });

  it("refuses the same model twice", async () => {
    recordedModel("org/a", true);
    await expect(runServe(["mlx:org/a", "mlx:org/a"], {}, deps)).rejects.toThrow(
      "org/a is named twice.",
    );
  });

  it("stops everything when a process exits before it is ready", async () => {
    recordedModel("org/a", true);
    recordedModel("org/b", true);
    const children: ReturnType<typeof fakeChild>[] = [];
    const failing: ServeDeps = {
      ...deps,
      spawn: () => {
        const child = fakeChild();
        children.push(child);
        if (children.length === 2) {
          setTimeout(() => child.exit(1), 5);
        }
        return child;
      },
      fetch: (async (url: string) => {
        if (url.includes(":9000/")) return new Response("{}", { status: 200 });
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    };
    await expect(runServe(["mlx:org/a", "mlx:org/b"], { port: 0 }, failing)).rejects.toThrow(
      "mlx_lm.server for org/b exited with 1 before it was ready.",
    );
    expect(killed).toBe(2);
  });

  it("reports a process that dies after it was ready, and stays quiet after close", async () => {
    recordedModel("org/a", true);
    let child: ReturnType<typeof fakeChild> | undefined;
    const handle = await runServe(
      ["mlx:org/a"],
      { port: 0 },
      {
        ...deps,
        spawn: () => {
          child = fakeChild();
          return child;
        },
      },
    );
    child!.exit(137);
    expect(await handle.failure).toBe("mlx_lm.server for org/a exited with 137.");
    await handle.close();
  });
});
