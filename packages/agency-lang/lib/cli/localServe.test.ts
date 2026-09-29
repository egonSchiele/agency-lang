import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeDeleteDirectoryWithin } from "../utils.js";
import {
  serveArgs,
  promptCacheBudget,
  prefillStepSize,
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
  embedServeArgs,
  speechServeArgs,
  imageServeArgs,
  groupServeArgv,
  optionsByModel,
  argvAfterServe,
  valueFlagsOf,
  pickModelsToServe,
  type ServeDeps,
  type Child,
  type PickDeps,
} from "./localServe.js";
import { CURATED_LOCAL_MODELS } from "../stdlib/localModels.js";
import { createProgram } from "../../scripts/agency.js";

describe("serveArgs", () => {
  it("builds the chat server command line, with mlx_lm.server's options", () => {
    expect(
      serveArgs("/pkg/lib/cli/mlxChatServer.py", "/models/mlx/org--repo", 8081, {
        maxTokens: 16384,
        promptCacheBytes: 4_000_000_000,
        prefillStepSize: 2048,
        limits: {},
      }),
    ).toEqual([
      "/pkg/lib/cli/mlxChatServer.py",
      "--model",
      "/models/mlx/org--repo",
      "--host",
      "127.0.0.1",
      "--port",
      "8081",
      "--max-tokens",
      "16384",
      "--prompt-cache-bytes",
      "4000000000",
      "--prefill-step-size",
      "2048",
      "--log-level",
      "INFO",
    ]);
  });

  it("adds a flag for each reply limit the user set, and none for the rest", () => {
    const args = serveArgs("/pkg/s.py", "/models/m", 8081, {
      maxTokens: 16384,
      promptCacheBytes: 1000,
      prefillStepSize: 2048,
      limits: { reasoningBudget: 0, repeatLimit: 5 },
    });
    expect(args.slice(-4)).toEqual(["--reasoning-budget", "0", "--repeat-limit", "5"]);
    expect(args).not.toContain("--hedge-limit");
    expect(args).not.toContain("--limit-answers");
    const watched = serveArgs("/pkg/s.py", "/models/m", 8081, {
      maxTokens: 16384,
      promptCacheBytes: 1000,
      prefillStepSize: 2048,
      limits: { limitAnswers: true },
    });
    expect(watched.slice(-1)).toEqual(["--limit-answers"]);
  });

  it("names the draft model and how much it drafts", () => {
    const args = serveArgs("/pkg/s.py", "/models/m", 8081, {
      maxTokens: 16384,
      promptCacheBytes: 1000,
      prefillStepSize: 2048,
      limits: {},
      draft: { dir: "/models/small", tokens: 4 },
    });
    expect(args.slice(-4)).toEqual(["--draft-model", "/models/small", "--num-draft-tokens", "4"]);
  });
});

describe("prefillStepSize", () => {
  it("reads a long prompt in bigger chunks on a machine with more memory", () => {
    expect(prefillStepSize(32 * 1024 ** 3)).toBe(2048);
    expect(prefillStepSize(64 * 1024 ** 3)).toBe(4096);
    expect(prefillStepSize(256 * 1024 ** 3)).toBe(8192);
  });
});

describe("promptCacheBudget", () => {
  it("is a sixteenth of the machine's memory", () => {
    expect(promptCacheBudget(256 * 1024 ** 3)).toBe(16 * 1024 ** 3);
    expect(promptCacheBudget(1_000_000_000)).toBe(62_500_000);
  });
});

describe("embedServeArgs", () => {
  it("builds the embedding server command line", () => {
    expect(
      embedServeArgs("/pkg/lib/cli/mlxEmbedServer.py", "/models/mlx/org--emb", 8082, 8192),
    ).toEqual([
      "/pkg/lib/cli/mlxEmbedServer.py",
      "--model",
      "/models/mlx/org--emb",
      "--host",
      "127.0.0.1",
      "--port",
      "8082",
      "--max-length",
      "8192",
    ]);
  });
});

// The flags of `agency local serve` and the commands above it, read from
// the real declarations, so the table below checks the grouping against
// what commander will accept.
function serveCommand() {
  const local = createProgram().commands.find((command) => command.name() === "local");
  const serve = local?.commands.find((command) => command.name() === "serve");
  if (serve === undefined) {
    throw new Error("no local serve command");
  }
  return serve;
}
const SERVE_FLAGS = valueFlagsOf(serveCommand());

describe("valueFlagsOf", () => {
  it("lists the flags that take a value, and leaves out the on/off ones", () => {
    expect(SERVE_FLAGS["--port"]).toBe("required");
    expect(SERVE_FLAGS["--draft"]).toBe("required");
    expect(SERVE_FLAGS["--draft-tokens"]).toBe("required");
    expect(SERVE_FLAGS["--limit-answers"]).toBeUndefined();
    expect(SERVE_FLAGS["--log-prompts"]).toBeUndefined();
    // A flag of the `local` command above serve counts too.
    expect(SERVE_FLAGS["--model-dir"]).toBe("required");
  });

  it("reads optional values and short spellings", () => {
    expect(
      valueFlagsOf({
        options: [{ long: "--color", short: "-c", required: false, optional: true }],
        parent: null,
      }),
    ).toEqual({ "--color": "optional", "-c": "optional" });
  });
});

describe("groupServeArgv", () => {
  const cases: { argv: string[]; targets: object[] }[] = [
    {
      argv: ["a", "--draft", "d", "--draft-tokens", "3", "b"],
      targets: [{ model: "a", draft: "d", draftTokens: 3 }, { model: "b" }],
    },
    // A model named with a kind flag is a target the options can follow.
    {
      argv: ["--image", "img", "a", "--draft", "d", "--embedding", "e"],
      targets: [{ model: "img" }, { model: "a", draft: "d" }, { model: "e" }],
    },
    // Command-wide flags and their values are stepped over.
    {
      argv: ["--port", "9090", "a", "--log-prompts", "--max-tokens=100", "--draft", "d"],
      targets: [{ model: "a", draft: "d" }],
    },
    // An on/off flag takes no value, so the model after it is a model.
    {
      argv: ["a", "--limit-answers", "b", "--draft", "d"],
      targets: [{ model: "a" }, { model: "b", draft: "d" }],
    },
    {
      argv: ["a", "--log-prompts", "b", "--draft", "d"],
      targets: [{ model: "a" }, { model: "b", draft: "d" }],
    },
    {
      argv: ["--limit-answers", "big", "--draft", "small"],
      targets: [{ model: "big", draft: "small" }],
    },
    // The `--flag=value` forms.
    {
      argv: ["big", "--draft=small", "--draft-tokens=3"],
      targets: [{ model: "big", draft: "small", draftTokens: 3 }],
    },
    {
      argv: ["a", "--image=img", "b", "--draft", "d"],
      targets: [{ model: "a" }, { model: "img" }, { model: "b", draft: "d" }],
    },
    {
      argv: ["a", "--port=9090", "--draft", "d"],
      targets: [{ model: "a", draft: "d" }],
    },
    { argv: [], targets: [] },
    { argv: ["--port", "8080"], targets: [] },
  ];
  for (const { argv, targets } of cases) {
    it(`groups ${JSON.stringify(argv)}`, () => {
      expect(groupServeArgv(argv, SERVE_FLAGS)).toEqual(targets);
    });
  }

  it("attaches a draft after --image=img to img, which serve then refuses", () => {
    expect(groupServeArgv(["a", "--image=img", "--draft", "d"], SERVE_FLAGS)).toEqual([
      { model: "a" },
      { model: "img", draft: "d" },
    ]);
  });

  it("refuses the old form, a draft before any model, naming the new form", () => {
    expect(() => groupServeArgv(["--draft", "d", "a"], SERVE_FLAGS)).toThrow(
      "--draft goes after the chat model it is for: agency local serve <model> --draft d",
    );
    expect(() => groupServeArgv(["--draft=d", "a"], SERVE_FLAGS)).toThrow(
      "--draft goes after the chat model it is for: agency local serve <model> --draft d",
    );
  });

  it("refuses --draft-tokens with no --draft for its model", () => {
    expect(() => groupServeArgv(["a", "--draft-tokens", "3"], SERVE_FLAGS)).toThrow(
      "--draft-tokens needs a --draft for a: agency local serve a --draft <model> --draft-tokens 3",
    );
    expect(() =>
      groupServeArgv(["a", "--draft", "d", "b", "--draft-tokens", "3"], SERVE_FLAGS),
    ).toThrow("--draft-tokens needs a --draft for b");
  });

  it("refuses two drafts for one model", () => {
    expect(() => groupServeArgv(["a", "--draft", "d", "--draft", "e"], SERVE_FLAGS)).toThrow(
      "a has --draft twice. Write it once after the model: agency local serve a --draft e",
    );
    expect(() =>
      groupServeArgv(["a", "--draft", "d", "--draft-tokens", "2", "--draft-tokens=3"], SERVE_FLAGS),
    ).toThrow("a has --draft-tokens twice.");
  });
});

describe("optionsByModel", () => {
  it("keeps only the models that have options", () => {
    expect(optionsByModel([{ model: "a", draft: "d" }, { model: "b" }])).toEqual({
      a: { draft: "d" },
    });
  });
});

describe("argvAfterServe", () => {
  it("returns the tokens after local serve", () => {
    expect(
      argvAfterServe(["node", "agency", "local", "serve", "a", "--draft", "d"], SERVE_FLAGS),
    ).toEqual(["a", "--draft", "d"]);
    expect(argvAfterServe(["node", "agency", "local", "list"], SERVE_FLAGS)).toEqual([]);
  });

  it("steps over a flag whose value is the word serve", () => {
    expect(
      argvAfterServe(
        ["node", "agency", "local", "--model-dir", "serve", "serve", "a", "--draft", "d"],
        SERVE_FLAGS,
      ),
    ).toEqual(["a", "--draft", "d"]);
    expect(
      argvAfterServe(["node", "agency", "--verbose", "local", "serve", "a"], SERVE_FLAGS),
    ).toEqual(["a"]);
  });
});

describe("imageServeArgs", () => {
  it("builds the image server command line", () => {
    expect(imageServeArgs("/x/diffusersImageServer.py", "/m/dir", 9003)).toEqual([
      "/x/diffusersImageServer.py",
      "--model",
      "/m/dir",
      "--host",
      "127.0.0.1",
      "--port",
      "9003",
    ]);
  });

  it("passes the adapters folder when one is configured", () => {
    const args = imageServeArgs("/x/s.py", "/m/dir", 9003, "/home/me/adapters");
    expect(args.slice(7)).toEqual(["--adapters-dir", "/home/me/adapters"]);
  });
});

describe("speechServeArgs", () => {
  it("builds the speech server command line", () => {
    expect(speechServeArgs("/x/mlxSpeechServer.py", "/m/dir", 9002, "/home/me/models")).toEqual([
      "/x/mlxSpeechServer.py",
      "--model",
      "/m/dir",
      "--host",
      "127.0.0.1",
      "--port",
      "9002",
      "--models-dir",
      "/home/me/models",
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
    const chat = "/v1/chat/completions";
    expect(notServedMessage(["a/one", "a/two"], "a/three", chat)).toBe(
      "This server is serving a/one and a/two. It is not serving a/three. Start it with: agency local serve mlx:a/three",
    );
    expect(notServedMessage(["a/one"], "a/three", chat)).toBe(
      "This server is serving a/one. It is not serving a/three. Start it with: agency local serve mlx:a/three",
    );
    expect(notServedMessage(["a/one", "a/two", "a/four"], "/m/dir", chat)).toBe(
      "This server is serving a/one, a/two and a/four. It is not serving /m/dir. Start it with: agency local serve /m/dir",
    );
  });

  it("notServedMessage names the flag and the URI prefix the request path needs", () => {
    // A bare repo id on the images path is a diffusers model: sending it to
    // `serve mlx:...` would download the whole repo unfiltered and still not serve.
    expect(notServedMessage(["a/chat"], "Tongyi-MAI/Z-Image-Turbo", "/v1/images/generations")).toBe(
      "This server is serving a/chat. It is not serving Tongyi-MAI/Z-Image-Turbo. Start it with: agency local serve --image diffusers:Tongyi-MAI/Z-Image-Turbo",
    );
    expect(notServedMessage(["a/chat"], "/m/zimage", "/v1/images/generations")).toBe(
      "This server is serving a/chat. It is not serving /m/zimage. Start it with: agency local serve --image /m/zimage",
    );
    expect(notServedMessage(["a/chat"], "mlx/tts", "/v1/audio/speech")).toBe(
      "This server is serving a/chat. It is not serving mlx/tts. Start it with: agency local serve --speech mlx:mlx/tts",
    );
    expect(notServedMessage(["a/chat"], "mlx/embed", "/v1/embeddings")).toBe(
      "This server is serving a/chat. It is not serving mlx/embed. Start it with: agency local serve --embedding mlx:mlx/embed",
    );
  });

  it("pythonMissingMessage shows the venv commands for the default environment", () => {
    const msg = pythonMissingMessage(
      "/usr/bin/python3",
      "/home/me",
      { kind: "cannot-import", module: "mlx_lm" },
      ["mlx_lm", "llguidance"],
    );
    expect(msg).toContain("/usr/bin/python3 cannot import mlx_lm.");
    expect(msg).toContain("python3.12 -m venv /home/me/.agency-agent/mlx-env");
    expect(msg).toContain(
      "/home/me/.agency-agent/mlx-env/bin/pip install mlx-lm==0.31.3 llguidance==1.8.0",
    );
    expect(msg).toContain("point --python at a Python that has");
  });

  it("pythonMissingMessage names llguidance when only it is missing", () => {
    const msg = pythonMissingMessage("/usr/bin/python3", "/home/me", {
      kind: "cannot-import",
      module: "llguidance",
    });
    expect(msg).toContain("/usr/bin/python3 cannot import llguidance.");
    expect(msg).toContain("/home/me/.agency-agent/mlx-env/bin/pip install llguidance==1.8.0");
    expect(msg).not.toContain("venv");
  });

  it("pythonMissingMessage says when the Python itself is not there", () => {
    const msg = pythonMissingMessage("/home/me/.agency-agent/mlx-env/bin/python", "/home/me", {
      kind: "missing",
    });
    expect(msg).toContain("/home/me/.agency-agent/mlx-env/bin/python does not exist.");
    expect(msg).toContain("python3.12 -m venv /home/me/.agency-agent/mlx-env");
  });

  it("pythonMissingMessage shows the pip line for a Python without mlx-audio", () => {
    const msg = pythonMissingMessage("/py/bin/python", "/home/me", {
      kind: "cannot-import",
      module: "mlx_audio",
    });
    expect(msg).toContain("/py/bin/python cannot import mlx_audio.");
    expect(msg).toContain("/home/me/.agency-agent/mlx-env/bin/pip install mlx-audio==0.5.4");
  });

  it("pythonMissingMessage names the image module that failed and installs every image package", () => {
    const msg = pythonMissingMessage("/py/bin/python", "/home/me", {
      kind: "cannot-import",
      module: "diffusers",
    });
    expect(msg).toContain("/py/bin/python cannot import diffusers.");
    expect(msg).toContain(
      "/home/me/.agency-agent/mlx-env/bin/pip install torch==2.14.0 diffusers==0.40.0 transformers==5.17.0 accelerate==1.15.0 sentencepiece==0.2.2 protobuf==7.36.2",
    );
    expect(msg).not.toContain("mlx-lm");
    expect(msg).not.toContain("mlx-audio");
  });

  it("pythonMissingMessage creates an environment with only the image packages for an image-only serve", () => {
    const msg = pythonMissingMessage("/py/bin/python", "/home/me", { kind: "missing" }, [
      "torch",
      "diffusers",
      "transformers",
      "accelerate",
    ]);
    expect(msg).toContain("python3.12 -m venv /home/me/.agency-agent/mlx-env");
    expect(msg).toContain(
      "/home/me/.agency-agent/mlx-env/bin/pip install torch==2.14.0 diffusers==0.40.0 transformers==5.17.0 accelerate==1.15.0 sentencepiece==0.2.2 protobuf==7.36.2\n",
    );
    expect(msg).not.toContain("mlx-lm");
  });

  it("pythonMissingMessage installs what the planned kinds need", () => {
    const msg = pythonMissingMessage("/py/bin/python", "/home/me", { kind: "missing" }, [
      "mlx_lm",
      "mlx_audio",
    ]);
    expect(msg).toContain(
      "/home/me/.agency-agent/mlx-env/bin/pip install mlx-lm==0.31.3 mlx-audio==0.5.4",
    );
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

  it("probes an embedding process with an embeddings request", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await waitUntilLoaded(8082, "/m/emb", { fetch: fetchFn, kind: "embedding" });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8082/v1/embeddings",
        body: { model: "/m/emb", input: "hi" },
      },
    ]);
  });

  it("probes a speech process with GET /health, since it speaks once before opening its port", async () => {
    const seen: { url: string; method: string | undefined }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method });
      return new Response('{"status":"ok"}', { status: 200 });
    }) as unknown as typeof fetch;
    await waitUntilLoaded(9002, "/m/dir", { fetch: fetchFn, kind: "speech" });
    expect(seen).toEqual([{ url: "http://127.0.0.1:9002/health", method: "GET" }]);
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
    expect(checkPython("/x/python", () => ({ status: 1 }))).toEqual({
      kind: "cannot-import",
      module: "mlx_lm",
    });
    expect(checkPython("/x/python", () => ({ status: null, error: { code: "ENOENT" } }))).toEqual({
      kind: "missing",
    });
  });

  it("reports a Python that does not exist", () => {
    expect(checkPython("/no/such/python")).toEqual({ kind: "missing" });
  });

  it("checks each module it is asked for, and names the first that fails", () => {
    const asked: string[] = [];
    const exec = (_cmd: string, args: string[]) => {
      asked.push(args[1]);
      return { status: args[1] === "import mlx_audio" ? 1 : 0 };
    };
    expect(checkPython("py", exec, ["mlx_lm", "mlx_audio"])).toEqual({
      kind: "cannot-import",
      module: "mlx_audio",
    });
    expect(asked).toEqual(["import mlx_lm", "import mlx_audio"]);
    expect(checkPython("py", exec, ["mlx_lm"])).toBe("ok");
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
    expect(
      servingBanner(8080, [
        { name: "org/a", kind: "chat" },
        { name: "/m/dir", kind: "chat" },
      ]),
    ).toEqual([
      "Serving 2 models on http://127.0.0.1:8080/v1:",
      "  org/a",
      "  /m/dir",
      "",
      "  agency run --local mlx:org/a your.agency",
      "  agency agent --local mlx:org/a",
    ]);
    const dirOnly = servingBanner(8080, [{ name: "/m/dir", kind: "chat" }]);
    expect(dirOnly[0]).toBe("Serving 1 model on http://127.0.0.1:8080/v1:");
    expect(dirOnly[3]).toBe("  agency run --local /m/dir your.agency");
  });

  it("marks image models and shows the generateImageLocal call for the first", () => {
    expect(servingBanner(8080, [{ name: "org/img", kind: "image" }])).toEqual([
      "Serving 1 model on http://127.0.0.1:8080/v1:",
      "  org/img  (images)",
      "",
      "  In Agency code:",
      `    import { generateImageLocal } from "std::image"`,
      `    generateImageLocal("a lighthouse in a storm", "org/img")`,
    ]);
  });

  it("marks speech models and shows the speakLocal call for the first", () => {
    expect(servingBanner(8080, [{ name: "org/tts", kind: "speech" }])).toEqual([
      "Serving 1 model on http://127.0.0.1:8080/v1:",
      "  org/tts  (speech)",
      "",
      "  In Agency code:",
      `    import { speakLocal } from "std::speech"`,
      `    speakLocal("Hello there.", "org/tts")`,
    ]);
  });

  it("marks embedding models and shows the memory config for the first", () => {
    expect(
      servingBanner(8080, [
        { name: "org/a", kind: "chat" },
        { name: "org/emb", kind: "embedding" },
      ]),
    ).toEqual([
      "Serving 2 models on http://127.0.0.1:8080/v1:",
      "  org/a",
      "  org/emb  (embeddings)",
      "",
      "  agency run --local mlx:org/a your.agency",
      "  agency agent --local mlx:org/a",
      "",
      "  For memory, set in agency.json:",
      '    "memory": { "dir": ".agency-memory", "embeddings": { "model": "org/emb", "provider": "mlx" } }',
    ]);
    expect(servingBanner(8080, [{ name: "org/emb", kind: "embedding" }])).toEqual([
      "Serving 1 model on http://127.0.0.1:8080/v1:",
      "  org/emb  (embeddings)",
      "",
      "  For memory, set in agency.json:",
      '    "memory": { "dir": ".agency-memory", "embeddings": { "model": "org/emb", "provider": "mlx" } }',
    ]);
  });
});

describe("runServe", () => {
  let dir: string;
  let cacheDir: string;
  let spawned: string[][];
  let killed: number;
  let log: string[];
  let deps: ServeDeps;
  const CHAT_CONFIG = JSON.stringify({ architectures: ["Qwen3ForCausalLM"] });
  const IMAGE_INDEX = JSON.stringify({ _class_name: "ZImagePipeline" });

  /** The config.json that says what a fixture model is, so `serve` reads
   *  its kind from the files the way a real download's would be read. */
  const CONFIG_FOR_KIND: Record<string, string> = {
    chat: CHAT_CONFIG,
    embedding: JSON.stringify({ architectures: ["Qwen3Model"] }),
    speech: JSON.stringify({ model_type: "qwen3_tts", tts_model_type: "custom_voice" }),
  };

  /** A downloaded model under <cacheDir>/mlx with a complete record. */
  function recordedModel(repo: string, complete: boolean, kind: string = "chat"): string {
    const model = path.join(cacheDir, "mlx", repo.replace("/", "--"));
    const config = CONFIG_FOR_KIND[kind];
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, "config.json"), config);
    fs.writeFileSync(path.join(model, "model.safetensors"), "xxxxxxxx");
    fs.writeFileSync(
      path.join(model, ".agency-model.json"),
      JSON.stringify({
        repo,
        revision: "abc",
        files: {
          "config.json": { size: config.length, complete: true },
          "model.safetensors": { size: 600e6, complete },
        },
      }),
    );
    return model;
  }

  /** A downloaded diffusers model under <cacheDir>/diffusers with a
   *  complete record. */
  function diffusersModel(repo: string): string {
    const model = path.join(cacheDir, "diffusers", repo.replace("/", "--"));
    fs.mkdirSync(path.join(model, "transformer"), { recursive: true });
    fs.writeFileSync(path.join(model, "model_index.json"), IMAGE_INDEX);
    fs.writeFileSync(path.join(model, "transformer", "model.safetensors"), "xxxxxxxx");
    fs.writeFileSync(
      path.join(model, ".agency-model.json"),
      JSON.stringify({
        repo,
        revision: "abc",
        files: {
          "model_index.json": { size: IMAGE_INDEX.length, complete: true },
          "transformer/model.safetensors": { size: 600e6, complete: true },
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
      adaptersDir: null,
      useColor: false,
    };
  });

  afterEach(() => {
    safeDeleteDirectoryWithin(os.tmpdir(), dir);
  });

  it("drafts for the model an option was written after, and counts that draft's memory once", async () => {
    recordedModel("org/a", true);
    recordedModel("org/b", true);
    const d = recordedModel("org/d", true);
    const handle = await runServe(
      ["mlx:org/a", "mlx:org/b"],
      { port: 0, options: { "mlx:org/a": { draft: "mlx:org/d", draftTokens: 3 } } },
      deps,
    );
    expect(spawned[0].slice(-4)).toEqual(["--draft-model", d, "--num-draft-tokens", "3"]);
    expect(spawned[1]).not.toContain("--draft-model");
    // Two 0.6 GB models plus the 0.6 GB draft loaded by one of them, on a
    // 1 GB machine.
    expect(log[0]).toBe(
      "Warning: these models total 1.80 GB and this machine has 1.00 GB of memory.",
    );
    expect(log).toContain("Drafting for org/a with org/d (0.60 GB)");
    await handle.close();
  });

  it("refuses a draft for a model that is not a chat model, and a draft that is not one", async () => {
    diffusersModel("org/img");
    recordedModel("org/a", true);
    recordedModel("org/tts", true, "speech");
    await expect(
      runServe(
        ["diffusers:org/img"],
        { port: 0, options: { "diffusers:org/img": { draft: "mlx:org/a" } } },
        deps,
      ),
    ).rejects.toThrow(
      "--draft goes after a chat model, and diffusers:org/img is an image model. " +
        "Write it after the chat model it drafts for: agency local serve <model> --draft mlx:org/a",
    );
    await expect(
      runServe(
        ["mlx:org/a"],
        { port: 0, options: { "mlx:org/a": { draft: "mlx:org/tts" } } },
        deps,
      ),
    ).rejects.toThrow(
      "mlx:org/tts is a speech model, not a chat model. Serve it with: agency local serve --speech mlx:org/tts",
    );
    expect(spawned).toEqual([]);
  });

  it("resolves, warns, starts one process per model, waits, then opens the door", async () => {
    const a = recordedModel("org/a", true);
    const b = recordedModel("org/b", true);
    const handle = await runServe(["mlx:org/a", "mlx:org/b"], { port: 0 }, deps);
    expect(spawned[0][1].endsWith("/lib/cli/mlxChatServer.py")).toBe(true);
    expect(spawned[1][1].endsWith("/lib/cli/mlxChatServer.py")).toBe(true);
    expect(spawned.map((args) => [args[0], ...args.slice(2)])).toEqual([
      [
        "/home/me/.agency-agent/mlx-env/bin/python",
        "--model",
        a,
        "--host",
        "127.0.0.1",
        "--port",
        "9000",
        "--max-tokens",
        "16384",
        "--prompt-cache-bytes",
        "62500000",
        "--prefill-step-size",
        "2048",
        "--log-level",
        "INFO",
      ],
      [
        "/home/me/.agency-agent/mlx-env/bin/python",
        "--model",
        b,
        "--host",
        "127.0.0.1",
        "--port",
        "9001",
        "--max-tokens",
        "16384",
        "--prompt-cache-bytes",
        "62500000",
        "--prefill-step-size",
        "2048",
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

  it("serves an embedding model with the embedding server, probed on /v1/embeddings", async () => {
    const a = recordedModel("org/a", true);
    const emb = recordedModel("org/emb", true, "embedding");
    const probes: string[] = [];
    deps.fetch = (async (url: string) => {
      probes.push(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const handle = await runServe(["mlx:org/a"], { port: 0, embedding: ["mlx:org/emb"] }, deps);
    expect(spawned.length).toBe(2);
    expect(spawned[0][1].endsWith("/lib/cli/mlxChatServer.py")).toBe(true);
    expect(spawned[0].slice(2, 4)).toEqual(["--model", a]);
    expect(spawned[1][1].endsWith("/lib/cli/mlxEmbedServer.py")).toBe(true);
    expect(spawned[1].slice(2)).toEqual([
      "--model",
      emb,
      "--host",
      "127.0.0.1",
      "--port",
      "9001",
      "--max-length",
      "8192",
    ]);
    expect(probes).toEqual([
      "http://127.0.0.1:9000/v1/chat/completions",
      "http://127.0.0.1:9001/v1/embeddings",
    ]);
    expect(handle.models).toEqual(["org/a", "org/emb"]);
    expect(log).toContain("  org/emb  (embeddings)");
    expect(log).toContain(
      '    "memory": { "dir": ".agency-memory", "embeddings": { "model": "org/emb", "provider": "mlx" } }',
    );
    await handle.close();
  });

  it("refuses a catalog chat model passed with --embedding, before looking for its files", async () => {
    await expect(
      runServe([], { port: 0, embedding: ["qwen3-coder-next-mlx"] }, deps),
    ).rejects.toThrow(
      "qwen3-coder-next-mlx is a chat model, not an embedding model. Serve it with: agency local serve qwen3-coder-next-mlx",
    );
    expect(spawned).toEqual([]);
  });

  it("refuses an empty plan", async () => {
    await expect(runServe([], { port: 0 }, deps)).rejects.toThrow("Name at least one model");
  });

  it("serves a model directory under the name run --local sends", async () => {
    const model = path.join(dir, "snapshot");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "config.json"), CHAT_CONFIG);
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
    fs.writeFileSync(path.join(snapshot, "config.json"), CHAT_CONFIG);
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

  it("serves a pinned revision that is not the one refs/main names", async () => {
    hubModel("org/hub", "abc123");
    const older = path.join(cacheDir, "models--org--hub", "snapshots", "def456");
    fs.mkdirSync(older, { recursive: true });
    fs.writeFileSync(path.join(older, "config.json"), CHAT_CONFIG);
    fs.writeFileSync(path.join(older, "model.safetensors"), "xxxxxxxx");
    const handle = await runServe(["mlx:org/hub@def456"], { port: 0 }, deps);
    expect(spawned[0]).toContain(older);
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
      '"smollm2-135m" is a GGUF model. agency local serve is for MLX and diffusers models; run it with agency run --local smollm2-135m instead.',
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

  it("serves a speech model with the speech server, probed on /health", async () => {
    const tts = recordedModel("org/tts", true, "speech");
    const probes: string[] = [];
    const imports: string[] = [];
    deps.fetch = (async (url: string) => {
      probes.push(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    deps.exec = (_cmd, args) => {
      imports.push(args[1]);
      return { status: 0 };
    };
    const handle = await runServe([], { port: 0, speech: ["mlx:org/tts"] }, deps);
    expect(imports).toEqual(["import mlx_audio"]);
    expect(spawned.length).toBe(1);
    expect(spawned[0][1].endsWith("/lib/cli/mlxSpeechServer.py")).toBe(true);
    expect(spawned[0].slice(2)).toEqual([
      "--model",
      tts,
      "--host",
      "127.0.0.1",
      "--port",
      "9000",
      "--models-dir",
      cacheDir,
    ]);
    expect(probes).toEqual(["http://127.0.0.1:9000/health"]);
    expect(handle.models).toEqual(["org/tts"]);
    expect(log).toContain("  org/tts  (speech)");
    await handle.close();
  });

  it("serves a diffusers model with the image server, probed on /health, importing only image modules", async () => {
    const img = diffusersModel("org/img");
    const probes: string[] = [];
    const imports: string[] = [];
    deps.fetch = (async (url: string) => {
      probes.push(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    deps.exec = (_cmd, args) => {
      imports.push(args[1]);
      return { status: 0 };
    };
    const handle = await runServe([], { port: 0, image: ["diffusers:org/img"] }, deps);
    expect(imports).toEqual([
      "import torch",
      "import diffusers",
      "import transformers",
      "import accelerate",
    ]);
    expect(spawned[0][1].endsWith("/lib/cli/diffusersImageServer.py")).toBe(true);
    expect(spawned[0].slice(2)).toEqual(["--model", img, "--host", "127.0.0.1", "--port", "9000"]);
    expect(probes).toEqual(["http://127.0.0.1:9000/health"]);
    expect(log).toContain("Loading org/img (0.60 GB)…");
    expect(log).toContain("  org/img  (images)");
    await handle.close();
  });

  it("hands the adapters folder to an image server, and to no other kind", async () => {
    const img = diffusersModel("org/img");
    recordedModel("org/a", true);
    deps.adaptersDir = "/home/me/adapters";
    const handle = await runServe(["diffusers:org/img", "mlx:org/a"], { port: 0 }, deps);
    expect(spawned[0].slice(2)).toEqual([
      "--model",
      img,
      "--host",
      "127.0.0.1",
      "--port",
      "9000",
      "--adapters-dir",
      "/home/me/adapters",
    ]);
    expect(spawned[1]).not.toContain("--adapters-dir");
    await handle.close();
  });

  it("serves a diffusers model named without a flag, reading its kind from its files", async () => {
    const img = diffusersModel("org/img");
    const handle = await runServe(["diffusers:org/img"], { port: 0 }, deps);
    expect(spawned[0][1].endsWith("/lib/cli/diffusersImageServer.py")).toBe(true);
    expect(spawned[0].slice(2)).toEqual(["--model", img, "--host", "127.0.0.1", "--port", "9000"]);
    expect(log).toContain("  org/img  (images)");
    await handle.close();
  });

  /** A model directory whose files match no kind rule. */
  function mysteryModel(): string {
    const model = path.join(cacheDir, "mystery");
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "xxxxxxxx");
    return model;
  }

  it("refuses a directory whose files say nothing, naming the flags that say it", async () => {
    const model = mysteryModel();
    const refusal = runServe([model], { port: 0 }, deps);
    await expect(refusal).rejects.toThrow(
      `agency cannot tell from its files what kind of model ${model} is.`,
    );
    await expect(refusal).rejects.toThrow(`agency local serve --embedding ${model}`);
    await expect(refusal).rejects.not.toThrow("download --kind");
    expect(spawned).toEqual([]);
  });

  it("takes the kind from a flag when the files say nothing", async () => {
    const model = mysteryModel();
    const handle = await runServe([], { port: 0, embedding: [model] }, deps);
    expect(spawned[0][1].endsWith("/lib/cli/mlxEmbedServer.py")).toBe(true);
    await handle.close();
  });

  it("takes the kind from a flag over the files, which can be wrong", async () => {
    // An embedding model whose config names a ForCausalLM class, which the
    // file rules read as chat.
    recordedModel("org/emb-causal", true);
    const handle = await runServe([], { port: 0, embedding: ["mlx:org/emb-causal"] }, deps);
    expect(spawned[0][1].endsWith("/lib/cli/mlxEmbedServer.py")).toBe(true);
    await handle.close();
  });

  it("refuses a flag the catalog disagrees with", async () => {
    await expect(runServe([], { port: 0, image: ["qwen3-tts-mlx"] }, deps)).rejects.toThrow(
      "qwen3-tts-mlx is a speech model, not an image model. Serve it with: agency local serve --speech qwen3-tts-mlx",
    );
    expect(spawned).toEqual([]);
  });

  it("asks for mlx_lm and llguidance for a chat model, and mlx_audio for speech", async () => {
    recordedModel("org/a", true);
    recordedModel("org/tts", true, "speech");
    const imports: string[] = [];
    deps.exec = (_cmd, args) => {
      imports.push(args[1]);
      return { status: 0 };
    };
    const handle = await runServe(["mlx:org/a"], { port: 0, speech: ["mlx:org/tts"] }, deps);
    expect(imports).toEqual(["import mlx_lm", "import llguidance", "import mlx_audio"]);
    await handle.close();
  });

  it("refuses a chat model passed with --speech, and a speech model passed with --embedding", async () => {
    await expect(runServe([], { port: 0, speech: ["qwen3-coder-next-mlx"] }, deps)).rejects.toThrow(
      "qwen3-coder-next-mlx is a chat model, not a speech model. Serve it with: agency local serve qwen3-coder-next-mlx",
    );
    await expect(runServe([], { port: 0, embedding: ["qwen3-tts-mlx"] }, deps)).rejects.toThrow(
      "qwen3-tts-mlx is a speech model, not an embedding model. Serve it with: agency local serve --speech qwen3-tts-mlx",
    );
    expect(spawned).toEqual([]);
  });

  it("names the speech server when it exits before it is ready", async () => {
    recordedModel("org/tts", true, "speech");
    const failing: ServeDeps = {
      ...deps,
      spawn: () => {
        const child = fakeChild();
        setTimeout(() => child.exit(1), 5);
        return child;
      },
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    };
    await expect(runServe([], { port: 0, speech: ["mlx:org/tts"] }, failing)).rejects.toThrow(
      "the speech server for org/tts exited with 1 before it was ready.",
    );
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
      kind: "chat" as const,
    },
    {
      name: "org/a",
      path: "/m/mlx/org--a",
      sizeBytes: 12.4e9,
      backend: "mlx" as const,
      complete: true,
      layout: "hub" as const,
      kind: "chat" as const,
    },
    {
      name: "org/half",
      path: "/m/mlx/org--half",
      sizeBytes: 1e9,
      backend: "mlx" as const,
      complete: false,
      layout: "agency" as const,
      kind: "chat" as const,
    },
    {
      name: "org/unknown",
      path: "/m/mlx/org--unknown",
      sizeBytes: 1e9,
      backend: "mlx" as const,
      complete: true,
      layout: "agency" as const,
    },
  ];

  it("offers the complete served models by repo id, whichever layout holds them", () => {
    expect(serveChoices(downloaded)).toEqual([
      { title: "org/a  (12.40 GB, chat)", value: "mlx:org/a" },
      { title: "org/b  (4.20 GB, chat)", value: "mlx:org/b" },
    ]);
  });

  it("names each model's kind, and offers every kind", () => {
    const emb = CURATED_LOCAL_MODELS["qwen3-embedding-4b-mlx"].uri.slice("mlx:".length);
    const withEmb = [
      ...downloaded,
      {
        name: emb,
        path: `/m/mlx/${emb.replace("/", "--")}`,
        sizeBytes: 2.28e9,
        backend: "mlx" as const,
        complete: true,
        layout: "agency" as const,
        kind: "embedding" as const,
      },
      {
        name: "org/img",
        path: "/m/diffusers/org--img",
        sizeBytes: 3e9,
        backend: "diffusers" as const,
        complete: true,
        layout: "agency" as const,
        kind: "image" as const,
      },
    ];
    expect(serveChoices(withEmb)).toEqual([
      { title: `${emb}  (2.28 GB, embedding)`, value: `mlx:${emb}` },
      { title: "org/a  (12.40 GB, chat)", value: "mlx:org/a" },
      { title: "org/b  (4.20 GB, chat)", value: "mlx:org/b" },
      { title: "org/img  (3.00 GB, image)", value: "diffusers:org/img" },
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
        kind: "chat" as const,
      },
      {
        name: "org/a",
        path: "/m/hub/models--org--a/snapshots/abc",
        sizeBytes: 1e9,
        backend: "mlx" as const,
        complete: true,
        layout: "hub" as const,
        kind: "chat" as const,
      },
    ];
    expect(serveChoices(both).map((c) => c.value)).toEqual(["mlx:org/a"]);
  });

  it("leaves out GGUF models, half-downloaded ones, and ones of no known kind", () => {
    const titles = serveChoices(downloaded).map((c) => c.title);
    expect(titles.some((t) => t.includes("smollm2"))).toBe(false);
    expect(titles.some((t) => t.includes("half"))).toBe(false);
    // serve would refuse it unflagged, and the picker cannot pass a flag.
    expect(titles.some((t) => t.includes("unknown"))).toBe(false);
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
    kind: "chat" as const,
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

  it("says what to run when no model is downloaded", async () => {
    await expect(
      pickModelsToServe(deps({ downloaded: () => [mlx("org/half", false)] })),
    ).rejects.toThrow("No models are downloaded");
  });

  it("off a terminal, names the models it could have served and fails", async () => {
    await expect(pickModelsToServe(deps({ tty: false }))).rejects.toThrow(
      /Pass a model: agency local serve <name>[\s\S]*mlx:org\/a/,
    );
  });
});
