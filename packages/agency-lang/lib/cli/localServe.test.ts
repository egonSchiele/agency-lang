import { describe, it, expect } from "vitest";
import {
  serveArgs,
  choosePython,
  memoryWarning,
  notServedMessage,
  pythonMissingMessage,
  waitUntilLoaded,
  checkPython,
  freePort,
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
    const gone = new Promise<string>((resolve) => setTimeout(() => resolve("exited with 1"), 15));
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
