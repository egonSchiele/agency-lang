# MLX Plan 2: `agency local serve`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command that serves the MLX models you name, in your terminal, and refuses every other model.

**Architecture:** `serve` starts one `mlx_lm.server` process per model on internal ports, waits until each has loaded, then listens on the public port itself. It reads the `model` field of each request and forwards the request to the matching process. A request for any other model gets a 404 with a message. Everything that can be a pure function is one, so it can be tested without a real server.

**Tech Stack:** TypeScript, `node:http`, `node:child_process`, vitest.

**Spec:** `2026-09-07-mlx-local-models-spec.md`, section 3.5 and 3.8. Depends on Plan 1 being merged.

## Global Constraints

- `serve` never downloads. A missing or incomplete model is an error naming the `download` command.
- Python is chosen in this order: `--python`, `client.mlx.python` in `agency.json`, `AGENCY_MLX_PYTHON`, `~/.agency-agent/mlx-env/bin/python`.
- Defaults: `--port 8080`, `--max-tokens 16384`. Internal ports start at `port + 1`.
- The memory warning prints and continues. It never refuses.
- The front door answers `GET /v1/models` with the served list.
- Same repo rules as Plan 1: fmt, lint, message files, never `main`.

---

### Task 0: Branch

- [ ] **Step 1**

```bash
cd /Users/adityabhargava/agency-lang
git worktree add worktree-mlx-serve -b adit/mlx-serve main
cd worktree-mlx-serve/packages/agency-lang
git checkout adit/mlx-spike -- packages/agency-lang/2026-09-07-mlx-plan-2-serve.md
make > /tmp/make.log 2>&1; tail -3 /tmp/make.log
```

If Plan 1 is not on `main` yet, branch from `adit/mlx-backend` instead.

---

### Task 1: Pure helpers: arguments, Python choice, memory warning

**Files:**
- Create: `lib/cli/localServe.ts`
- Test: `lib/cli/localServe.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ServeOptions = { port: number; maxTokens: number; python?: string };
  export function serveArgs(modelDir: string, internalPort: number, maxTokens: number): string[];
  export function choosePython(flag: string | undefined, configured: string | undefined, env: string | undefined, home: string): string;
  export function memoryWarning(sizesBytes: number[], totalMemBytes: number): string | null;
  export function notServedMessage(served: string[], requested: string, baseUrl: string): string;
  export function pythonMissingMessage(python: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `lib/cli/localServe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  serveArgs,
  choosePython,
  memoryWarning,
  notServedMessage,
  pythonMissingMessage,
} from "./localServe.js";

describe("serveArgs", () => {
  it("builds the mlx_lm.server command line", () => {
    expect(serveArgs("/models/mlx/org--repo", 8081, 16384)).toEqual([
      "-m", "mlx_lm.server",
      "--model", "/models/mlx/org--repo",
      "--host", "127.0.0.1",
      "--port", "8081",
      "--max-tokens", "16384",
      "--log-level", "INFO",
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
    expect(notServedMessage(["a/one", "a/two"], "a/three", "http://127.0.0.1:8080/v1")).toBe(
      "This server is serving a/one and a/two. It is not serving a/three. Start it with: agency local serve mlx:a/three",
    );
  });
  it("pythonMissingMessage shows the venv commands", () => {
    const msg = pythonMissingMessage("/home/me/.agency-agent/mlx-env/bin/python");
    expect(msg).toContain("cannot import mlx_lm");
    expect(msg).toContain("python3.12 -m venv /home/me/.agency-agent/mlx-env");
    expect(msg).toContain("pip install mlx-lm");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run lib/cli/localServe.test.ts > /tmp/s1.log 2>&1; grep -E "×|FAIL|Cannot find" /tmp/s1.log | head
```

- [ ] **Step 3: Implement**

Create `lib/cli/localServe.ts` with the five functions. `memoryWarning` formats with one decimal: `(bytes / 1e9).toFixed(1)`. `notServedMessage` joins the served list with `", "` and `" and "` before the last item. For a served name that is a directory path, `notServedMessage` still prints the `mlx:` form only when the requested name is a repo id; when it is a path, print `agency local serve <path>`. `pythonMissingMessage` produces the block from spec section 3.5 step 4, deriving the venv directory from the Python path by taking the parent of `bin`.

- [ ] **Step 4: Run, then commit**

```bash
pnpm exec vitest run lib/cli/localServe.test.ts > /tmp/s1.log 2>&1; tail -6 /tmp/s1.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/cli/localServe.ts lib/cli/localServe.test.ts
printf 'agency local serve: pure helpers for arguments, python, and messages\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 2: The front door

**Files:**
- Create: `lib/cli/mlxFrontDoor.ts`
- Test: `lib/cli/mlxFrontDoor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Route = { model: string; port: number };
  export type FrontDoor = { port: number; close: () => Promise<void> };
  /** Listen on `port` and forward each request to the route whose model
   *  matches the request body's `model`. Unknown models get a 404. */
  export function startFrontDoor(port: number, routes: Route[]): Promise<FrontDoor>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `lib/cli/mlxFrontDoor.test.ts`. It starts two fake `mlx_lm.server`s that record what they receive and reply with a canned completion naming themselves, then a front door on port 0 with routes to both:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { startFrontDoor, type FrontDoor } from "./mlxFrontDoor.js";

type Fake = { server: http.Server; port: number; hits: string[] };

async function fakeServer(model: string): Promise<Fake> {
  const fake: Fake = { server: undefined as unknown as http.Server, port: 0, hits: [] };
  fake.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      fake.hits.push(req.url ?? "");
      if (req.headers["x-stream"] === "1") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 20);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model, choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
  fake.port = (fake.server.address() as { port: number }).port;
  return fake;
}

let a: Fake, b: Fake, door: FrontDoor;
beforeAll(async () => {
  a = await fakeServer("org/a");
  b = await fakeServer("org/b");
  door = await startFrontDoor(0, [{ model: "org/a", port: a.port }, { model: "org/b", port: b.port }]);
});
afterAll(async () => {
  await door.close();
  a.server.close();
  b.server.close();
});

async function post(model: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${door.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [] }),
  });
}

describe("front door", () => {
  it("forwards to the process whose model matches", async () => {
    const res = await post("org/b");
    expect(res.status).toBe(200);
    expect((await res.json()).model).toBe("org/b");
    expect(b.hits).toEqual(["/v1/chat/completions"]);
    expect(a.hits).toEqual([]);
  });

  it("streams a reply through unchanged", async () => {
    const res = await post("org/a", { "x-stream": "1" });
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("refuses a model it does not serve, and no process sees it", async () => {
    const before = a.hits.length + b.hits.length;
    const res = await post("org/c");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toBe(
      "This server is serving org/a and org/b. It is not serving org/c. Start it with: agency local serve mlx:org/c",
    );
    expect(a.hits.length + b.hits.length).toBe(before);
  });

  it("lists the served models on GET /v1/models", async () => {
    const res = await fetch(`http://127.0.0.1:${door.port}/v1/models`);
    expect((await res.json()).data.map((m: { id: string }) => m.id)).toEqual(["org/a", "org/b"]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
pnpm exec vitest run lib/cli/mlxFrontDoor.test.ts > /tmp/s2.log 2>&1; grep -E "×|FAIL|Cannot find" /tmp/s2.log | head
```

- [ ] **Step 3: Implement**

`lib/cli/mlxFrontDoor.ts`:

```ts
import * as http from "node:http";
import { notServedMessage } from "./localServe.js";

export type Route = { model: string; port: number };
export type FrontDoor = { port: number; close: () => Promise<void> };

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startFrontDoor(port: number, routes: Route[]): Promise<FrontDoor> {
  const served = routes.map((r) => r.model);
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      json(res, 200, { object: "list", data: served.map((id) => ({ id, object: "model" })) });
      return;
    }
    const body = await readBody(req);
    let model: unknown;
    try {
      model = JSON.parse(body.toString("utf-8")).model;
    } catch {
      json(res, 400, { error: { message: "Request body is not JSON." } });
      return;
    }
    const route = routes.find((r) => r.model === model);
    if (route === undefined) {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      json(res, 404, { error: { message: notServedMessage(served, String(model), base) } });
      return;
    }
    const upstream = http.request(
      { host: "127.0.0.1", port: route.port, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => json(res, 502, { error: { message: `mlx_lm.server for ${route.model}: ${err.message}` } }));
    upstream.end(body);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const bound = (server.address() as { port: number }).port;
      resolve({ port: bound, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
```

The body is read in full before forwarding because the `model` field is inside it. Request bodies are small. Replies are piped, so streaming works.

- [ ] **Step 4: Run, then commit**

```bash
pnpm exec vitest run lib/cli/mlxFrontDoor.test.ts > /tmp/s2.log 2>&1; tail -6 /tmp/s2.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/cli/mlxFrontDoor.ts lib/cli/mlxFrontDoor.test.ts
printf 'agency local serve: the front door that forwards by model name\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 3: Starting the processes and waiting for each model

**Files:**
- Modify: `lib/cli/localServe.ts`
- Test: `lib/cli/localServe.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Spawner = (python: string, args: string[]) => { pid: number; on: (ev: "exit", cb: (code: number | null) => void) => void; kill: () => void };
  /** Send one 1-token completion to the internal port and resolve when it answers. */
  export function waitUntilLoaded(port: number, model: string, fetchFn?: typeof fetch): Promise<void>;
  export function checkPython(python: string, exec?: (cmd: string, args: string[]) => { status: number | null }): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("waitUntilLoaded", () => {
  it("resolves when the server answers the one-token request", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string).max_tokens);
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await waitUntilLoaded(8081, "org/a", fetchFn);
    expect(calls).toEqual([1]);
  });

  it("retries while the port is not open yet, then resolves", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      if (n < 3) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await waitUntilLoaded(8081, "org/a", fetchFn);
    expect(n).toBe(3);
  });
});

describe("checkPython", () => {
  it("passes when `python -c import mlx_lm` exits 0", () => {
    expect(checkPython("/x/python", () => ({ status: 0 }))).toBe(true);
    expect(checkPython("/x/python", () => ({ status: 1 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

`waitUntilLoaded` posts `{ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }` to `http://127.0.0.1:<port>/v1/chat/completions`. On a connection error it waits 500ms and tries again, forever. The server prints nothing while loading, so this request is the only readiness signal; it returns when the model is loaded. `checkPython` runs `spawnSync(python, ["-c", "import mlx_lm"])` through the injected `exec` and returns `status === 0`.

- [ ] **Step 3: Run, then commit**

```bash
pnpm exec vitest run lib/cli/localServe.test.ts > /tmp/s3.log 2>&1; tail -6 /tmp/s3.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/cli/localServe.ts lib/cli/localServe.test.ts
printf 'agency local serve: wait for each model to load\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 4: `runServe` and the CLI command

**Files:**
- Modify: `lib/cli/localServe.ts` (`runServe`)
- Modify: `scripts/agency.ts` (register `serve` under `localCmd`)
- Modify: `lib/config.ts` (`client.mlx.python`, `client.mlx.downloadConcurrency`)
- Test: `lib/cli/localServe.test.ts`

**Interfaces:**
- Consumes: `_resolveModel`, `_mlxServedName`, `mlxModelDir`, `readMlxModelRecord`, `isMlxModelComplete` from Plan 1.
- Produces: `runServe(values: string[], opts: { port?: number; maxTokens?: number; python?: string }, deps?)`. `deps` carries `spawn`, `fetch`, `exec`, `totalmem`, and `log`, all defaulting to the real ones, so the test can drive it.

- [ ] **Step 1: Write the failing test**

```ts
describe("runServe", () => {
  it("resolves, warns, starts one process per model, waits, then opens the door", async () => {
    // two model directories under a temp models dir, each with config.json,
    // one .safetensors file, and a complete .agency-model.json
    const spawned: string[][] = [];
    const log: string[] = [];
    const fakeFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const handle = await runServe(["mlx:org/a", "mlx:org/b"], { port: 0 }, {
      spawn: (python, args) => { spawned.push([python, ...args]); return { pid: 1, on: () => {}, kill: () => {} }; },
      fetch: fakeFetch,
      exec: () => ({ status: 0 }),
      totalmem: () => 1e9,
      log: (line) => log.push(line),
      cacheDir: dir,
    });
    expect(spawned.length).toBe(2);
    expect(spawned[0]).toContain("--port");
    expect(log.some((l) => l.startsWith("Warning: these models total"))).toBe(true);
    expect(log.some((l) => l.startsWith("Serving 2 models on http://127.0.0.1:"))).toBe(true);
    await handle.close();
  });

  it("refuses a GGUF model", async () => {
    await expect(runServe(["smollm2-135m"], {}, deps)).rejects.toThrow(
      '"smollm2-135m" is a GGUF model. agency local serve is for MLX models; run it with agency run --local smollm2-135m instead.',
    );
  });

  it("refuses a model that is not downloaded", async () => {
    await expect(runServe(["mlx:org/missing"], {}, deps)).rejects.toThrow(
      "org/missing is not downloaded. Run:\n  agency local download mlx:org/missing",
    );
  });

  it("refuses a Python without mlx_lm", async () => {
    await expect(runServe(["mlx:org/a"], {}, { ...deps, exec: () => ({ status: 1 }) })).rejects.toThrow(
      /cannot import mlx_lm/,
    );
  });
});
```

- [ ] **Step 2: Implement `runServe`**

In order:

1. Resolve each value with `_resolveModel`. A `llama-cpp` backend throws the GGUF message.
2. For an `mlx:` target, the directory is `mlxModelDir(cacheDir, repo)`; it must have a complete record, else throw the not-downloaded message. For a directory target, use it as is.
3. Sum sizes: from the record's file sizes, or from `list` for a directory alias. Print `memoryWarning(sizes, totalmem())` if not null.
4. `choosePython(opts.python, configured, process.env.AGENCY_MLX_PYTHON, os.homedir())`, where `configured` is `client.mlx.python` read through the same `readJson(resolveAliasConfigPath())` path `defaultCacheDir` uses. If `checkPython` fails, throw `pythonMissingMessage(python)`.
5. For each model, in order: internal port = `port + 1 + index`; `spawn(python, serveArgs(dir, internalPort, maxTokens))` with `stdio: "inherit"` and `HF_HUB_OFFLINE=1` in the environment; log `Loading <served name> (<size> GB)…`; `await waitUntilLoaded(internalPort, servedName)`; log `ready in <elapsed>`. If the process exits before that, throw `mlx_lm.server exited before it was ready.`
6. `startFrontDoor(port, routes)`, then log the `Serving N models on …` block and the two example commands from the spec.
7. On SIGINT or SIGTERM, kill every child and close the door. Return a handle with `close()` for the test.

The served name for each route is `_mlxServedName(resolved)`, the same function `run --local` uses.

- [ ] **Step 3: Register the command and the config keys**

In `scripts/agency.ts`, under `localCmd`:

```ts
  localCmd
    .command("serve")
    .description("Serve one or more MLX models in this terminal (start mlx_lm.server per model)")
    .argument("<models...>")
    .option("--port <n>", "Port to listen on", parseInt, 8080)
    .option("--max-tokens <n>", "Max tokens per reply the server allows", parseInt, 16384)
    .option("--python <path>", "Python with mlx-lm installed")
    .action((models: string[], opts: { port: number; maxTokens: number; python?: string }) =>
      localServe(models, opts),
    );
```

Add `localServe` to the imports from `@/cli/localServe.js`. `localServe` wraps `runServe`, prints an error message and exits 1 on a throw, and otherwise waits until the handle closes.

In `lib/config.ts`, add to the `client` type and the zod schema:

```ts
    mlx?: Partial<{
      /** Python with mlx-lm installed, used by `agency local serve`. */
      python: string;
      /** Parallel range requests during an MLX download. Default 8. */
      downloadConcurrency: number;
    }>;
```

- [ ] **Step 4: Run, build, and commit**

```bash
pnpm exec vitest run lib/cli/localServe.test.ts lib/cli/mlxFrontDoor.test.ts lib/config.test.ts > /tmp/s4.log 2>&1; tail -8 /tmp/s4.log
make > /tmp/make.log 2>&1; tail -3 /tmp/make.log
pnpm run agency local serve --help
pnpm run fmt:ts && pnpm run lint:structure
git add lib/cli/localServe.ts lib/cli/localServe.test.ts scripts/agency.ts lib/config.ts
printf 'agency local serve: the command\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 5: `mlxServerModels` in the stdlib

**Files:**
- Modify: `lib/stdlib/localModels.ts` (`_mlxServerModels`)
- Modify: `stdlib/agency/local.agency`
- Test: `lib/stdlib/localModels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("_mlxServerModels", () => {
  it("reads the served list from GET /v1/models, and null when nothing listens", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "org/a" }, { id: "org/b" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect(await _mlxServerModels(`http://127.0.0.1:${port}/v1`)).toEqual(["org/a", "org/b"]);
    server.close();
    expect(await _mlxServerModels(`http://127.0.0.1:${port}/v1`)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

```ts
/** The models the server at `baseUrl` serves, or null if nothing answers.
 *  An empty baseUrl means the mlx provider's default. */
export async function _mlxServerModels(baseUrl: string = ""): Promise<string[] | null> {
  const base = baseUrl === "" ? process.env.MLX_BASE_URL || "http://127.0.0.1:8080/v1" : baseUrl;
  try {
    const res = await fetch(`${base}/models`);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  } catch {
    return null;
  }
}
```

In `local.agency`:

```
export def mlxServerModels(baseUrl: string = ""): string[] | null {
  """
  The models the MLX server is serving, or null if no server is running.
  Use it to check a model is up before starting work.

  @param baseUrl - the server's URL (empty string = the mlx provider's default)
  """
  return _mlxServerModels(baseUrl)
}
```

- [ ] **Step 3: Run, build, and commit**

```bash
pnpm exec vitest run lib/stdlib/localModels.test.ts > /tmp/s5.log 2>&1; tail -6 /tmp/s5.log
make > /tmp/make.log 2>&1; tail -3 /tmp/make.log
pnpm run fmt:ts && pnpm run lint:structure
git add lib/stdlib/localModels.ts lib/stdlib/localModels.test.ts stdlib/agency/local.agency
printf 'std::agency/local: mlxServerModels\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

---

### Task 6: Dev doc, Studio check, PR

- [ ] **Step 1: Dev doc**

Add a "The serve command" section to `docs/dev/llm/mlx-local-models.md`: the one-process-per-model rule and why (the server loads any model it is asked for and holds one at a time), the front door and its 404, the readiness request, the Python choice order, the memory warning, and `GET /v1/models`. Remove the "not here yet" line about serve.

- [ ] **Step 2: On the Studio**

```bash
agency local serve /Volumes/adit-agency-models-sept-2026/hf/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/7b9321eabb85ce79625cac3f61ea691e4ea984b5 --python ~/mlx-env/bin/python
```

Expected: a Loading line, a ready line with a time, and the Serving block. In another terminal:

```bash
pnpm run agency run --local coder spikes/mlx-tool-calling/add.agency
pnpm run agency run --local mlx:mlx-community/DeepSeek-V4-Flash-4bit spikes/mlx-tool-calling/add.agency
```

Expected: the first prints `add called with 17 and 25`. The second fails with the "It is not serving" message, and the server terminal shows no load.

- [ ] **Step 3: PR**

```bash
pnpm run typecheck > /tmp/tc.log 2>&1; tail -3 /tmp/tc.log
pnpm run fmt:ts && pnpm run lint:structure
git push -u origin adit/mlx-serve
```

PR body in a file, opened with `gh pr create --body-file`. Do not merge.
