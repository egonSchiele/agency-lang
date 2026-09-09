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
  serveChoices,
  pickModelsToServe,
  type ServeDeps,
  type Child,
  type PickDeps,
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
      "Warning: these models total 196.40 GB and this machine has 64.00 GB of memory.",
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
    const msg = pythonMissingMessage("/usr/bin/python3", "/home/me", "no-mlx-lm");
    expect(msg).toContain("/usr/bin/python3 cannot import mlx_lm.");
    expect(msg).toContain("python3.12 -m venv /home/me/.agency-agent/mlx-env");
    expect(msg).toContain("/home/me/.agency-agent/mlx-env/bin/pip install mlx-lm");
    expect(msg).toContain("point --python at a Python that has");
  });

  it("pythonMissingMessage says when the Python itself is not there", () => {
    const msg = pythonMissingMessage(
      "/home/me/.agency-agent/mlx-env/bin/python",
      "/home/me",
      "missing",
    );
    expect(msg).toContain("/home/me/.agency-agent/mlx-env/bin/python does not exist.");
    expect(msg).toContain("python3.12 -m venv /home/me/.agency-agent/mlx-env");
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

  it("stops waiting on a request still open when the process is gone", async () => {
    const gone = new Promise<string>((resolve) =>
      setTimeout(() => resolve("mlx_lm.server for /m/dir exited with 1"), 15),
    );
    const fetchFn = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await expect(waitUntilLoaded(8081, "/m/dir", { fetch: fetchFn, gone })).rejects.toThrow(
      "mlx_lm.server for /m/dir exited with 1 before it was ready.",
    );
  });

  it("fails with the status and body when the server refuses the request", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "chat template missing" }), {
        status: 400,
      })) as unknown as typeof fetch;
    await expect(waitUntilLoaded(8081, "/m/dir", { fetch: fetchFn })).rejects.toThrow(
      'mlx_lm.server for /m/dir answered 400 to the readiness request: {"error":"chat template missing"}',
    );
  });
});

describe("checkPython", () => {
  it("ok when `python -c import mlx_lm` exits 0, else says which problem", () => {
    const seen: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      seen.push([cmd, ...args]);
      return { status: 0 };
    };
    expect(checkPython("/x/python", exec)).toBe("ok");
    expect(seen).toEqual([["/x/python", "-c", "import mlx_lm"]]);
    expect(checkPython("/x/python", () => ({ status: 1 }))).toBe("no-mlx-lm");
    expect(checkPython("/x/python", () => ({ status: null, error: { code: "ENOENT" } }))).toBe(
      "missing",
    );
  });

  it("reports a Python that does not exist", () => {
    expect(checkPython("/no/such/python")).toBe("missing");
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
      useColor: false,
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
      "Warning: these models total 1.20 GB and this machine has 1.00 GB of memory.",
    );
    expect(log[1]).toBe("Loading org/a (0.60 GB)…");
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

  /** A Hugging Face cache under the models directory, as another tool wrote it. */
  function hubModel(repo: string, sha: string): string {
    const folder = path.join(cacheDir, `models--${repo.replace("/", "--")}`);
    const snapshot = path.join(folder, "snapshots", sha);
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, "config.json"), "{}");
    fs.writeFileSync(path.join(snapshot, "model.safetensors"), "xxxxxxxx");
    fs.mkdirSync(path.join(folder, "refs"), { recursive: true });
    fs.writeFileSync(path.join(folder, "refs", "main"), sha);
    return snapshot;
  }

  it("serves a model in a Hugging Face cache under its repo id", async () => {
    const snapshot = hubModel("org/hub", "abc123");
    const handle = await runServe(["mlx:org/hub"], { port: 0 }, deps);
    // The process starts on the snapshot, but the model is named by its repo
    // id, which is what `run --local mlx:org/hub` sends.
    expect(spawned[0]).toContain(snapshot);
    expect(handle.models).toEqual(["org/hub"]);
    await handle.close();
  });

  it("refuses a pinned revision the cache does not hold", async () => {
    hubModel("org/hub", "abc123");
    await expect(runServe(["mlx:org/hub@ffffff"], { port: 0 }, deps)).rejects.toThrow(
      /holds org\/hub at abc123, and you asked for ffffff/,
    );
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

  it("refuses a Python without mlx_lm, or without a Python, before starting anything", async () => {
    recordedModel("org/a", true);
    await expect(
      runServe(["mlx:org/a"], {}, { ...deps, exec: () => ({ status: 1 }) }),
    ).rejects.toThrow(/cannot import mlx_lm/);
    await expect(
      runServe(
        ["mlx:org/a"],
        {},
        { ...deps, exec: () => ({ status: null, error: { code: "ENOENT" } }) },
      ),
    ).rejects.toThrow("/home/me/.agency-agent/mlx-env/bin/python does not exist.");
    expect(spawned).toEqual([]);
  });

  it("refuses a pinned revision the record does not match, and keeps the pin in the command", async () => {
    const model = recordedModel("org/a", true);
    await expect(runServe(["mlx:org/a@9c1f0a2"], {}, deps)).rejects.toThrow(
      `${model} holds org/a at abc, and you asked for 9c1f0a2. Run:\n  agency local download mlx:org/a@9c1f0a2`,
    );
    await expect(runServe(["mlx:org/b@abc"], {}, deps)).rejects.toThrow(
      "org/b is not downloaded. Run:\n  agency local download mlx:org/b@abc",
    );
    const handle = await runServe(["mlx:org/a@ab"], { port: 0 }, deps);
    expect(handle.models).toEqual(["org/a"]);
    await handle.close();
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

  it("stops everything when an earlier process dies while a later one is loading", async () => {
    recordedModel("org/a", true);
    recordedModel("org/b", true);
    const children: ReturnType<typeof fakeChild>[] = [];
    const failing: ServeDeps = {
      ...deps,
      spawn: () => {
        const child = fakeChild();
        children.push(child);
        return child;
      },
      fetch: (async (url: string) => {
        if (url.includes(":9000/")) return new Response("{}", { status: 200 });
        // b never answers; a dies meanwhile.
        setTimeout(() => children[0].exit(9), 5);
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch,
    };
    await expect(runServe(["mlx:org/a", "mlx:org/b"], { port: 0 }, failing)).rejects.toThrow(
      "mlx_lm.server for org/a exited with 9 before it was ready.",
    );
    expect(killed).toBe(2);
  });

  it("does not report a child that exits just before close(), as on Ctrl-C", async () => {
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
    child!.exit(130);
    await handle.close();
    const outcome = await Promise.race([
      handle.failure,
      new Promise<string>((r) => setTimeout(() => r("quiet"), 400)),
    ]);
    expect(outcome).toBe("quiet");
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

describe("serveChoices", () => {
  const downloaded = [
    {
      name: "smollm2.gguf",
      path: "/m/smollm2.gguf",
      sizeBytes: 1e9,
      backend: "llama-cpp" as const,
      complete: true,
      layout: "gguf" as const,
    },
    {
      name: "org/b",
      path: "/m/mlx/org--b",
      sizeBytes: 4.2e9,
      backend: "mlx" as const,
      complete: true,
      layout: "agency" as const,
    },
    {
      name: "org/a",
      path: "/m/mlx/org--a",
      sizeBytes: 12.4e9,
      backend: "mlx" as const,
      complete: true,
      layout: "hub" as const,
    },
    {
      name: "org/half",
      path: "/m/mlx/org--half",
      sizeBytes: 1e9,
      backend: "mlx" as const,
      complete: false,
      layout: "agency" as const,
    },
  ];

  it("offers the complete MLX models by repo id, whichever layout holds them", () => {
    expect(serveChoices(downloaded)).toEqual([
      { title: "org/a  (12.40 GB)", value: "mlx:org/a" },
      { title: "org/b  (4.20 GB)", value: "mlx:org/b" },
    ]);
  });

  it("offers one row for a repo that both layouts hold", () => {
    const both = [
      {
        name: "org/a",
        path: "/m/mlx/org--a",
        sizeBytes: 1e9,
        backend: "mlx" as const,
        complete: true,
        layout: "agency" as const,
      },
      {
        name: "org/a",
        path: "/m/hub/models--org--a/snapshots/abc",
        sizeBytes: 1e9,
        backend: "mlx" as const,
        complete: true,
        layout: "hub" as const,
      },
    ];
    expect(serveChoices(both).map((c) => c.value)).toEqual(["mlx:org/a"]);
  });

  it("leaves out GGUF models and half-downloaded ones", () => {
    const titles = serveChoices(downloaded).map((c) => c.title);
    expect(titles.some((t) => t.includes("smollm2"))).toBe(false);
    expect(titles.some((t) => t.includes("half"))).toBe(false);
  });
});

describe("pickModelsToServe", () => {
  const mlx = (name: string, complete = true) => ({
    name,
    path: `/m/mlx/${name.replace("/", "--")}`,
    sizeBytes: 1e9,
    backend: "mlx" as const,
    complete,
    layout: "agency" as const,
  });

  function deps(over: Partial<PickDeps> = {}): PickDeps {
    return {
      downloaded: () => [mlx("org/a"), mlx("org/b")],
      tty: true,
      ask: async () => ["mlx:org/a"],
      ...over,
    };
  }

  it("returns what was picked", async () => {
    expect(await pickModelsToServe(deps())).toEqual(["mlx:org/a"]);
  });

  it("passes the choices to the prompt", async () => {
    let seen: { value: string }[] = [];
    await pickModelsToServe(
      deps({
        ask: async (choices) => {
          seen = choices;
          return [];
        },
      }),
    );
    expect(seen.map((c) => c.value)).toEqual(["mlx:org/a", "mlx:org/b"]);
  });

  it("returns nothing when the prompt is cancelled or nothing is ticked", async () => {
    expect(await pickModelsToServe(deps({ ask: async () => null }))).toEqual([]);
    expect(await pickModelsToServe(deps({ ask: async () => [] }))).toEqual([]);
  });

  it("says what to run when no MLX model is downloaded", async () => {
    await expect(
      pickModelsToServe(deps({ downloaded: () => [mlx("org/half", false)] })),
    ).rejects.toThrow("No MLX models are downloaded");
  });

  it("off a terminal, names the models it could have served and fails", async () => {
    await expect(pickModelsToServe(deps({ tty: false }))).rejects.toThrow(
      /Pass a model: agency local serve <name>[\s\S]*mlx:org\/a/,
    );
  });
});
