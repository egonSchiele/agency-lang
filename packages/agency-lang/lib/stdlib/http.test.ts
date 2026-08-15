import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgencyCancelledError } from "../runtime/errors.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import {
  __internal_fetch,
  __internal_fetchJSON,
  __internal_fetchMarkdown,
  checkAllowedDomains,
  readBodyBytesCapped,
  resolveUrl,
  runHttp,
} from "./http.js";
import { AWS_OBJECT_BYTE_LIMIT } from "../constants.js";

function makeMockCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
}

describe("resolveUrl", () => {
  it("joins baseUrl and path", () => {
    expect(resolveUrl("https://api.github.com", "/repos")).toBe("https://api.github.com/repos");
  });

  it("uses baseUrl alone when path is empty", () => {
    expect(resolveUrl("https://api.github.com", "")).toBe("https://api.github.com");
  });

  it("handles trailing slash on baseUrl", () => {
    expect(resolveUrl("https://api.github.com/", "/repos")).toBe("https://api.github.com/repos");
  });

  it("handles path without leading slash", () => {
    expect(resolveUrl("https://api.github.com", "repos")).toBe("https://api.github.com/repos");
  });

  it("handles both trailing and leading slashes", () => {
    expect(resolveUrl("https://api.github.com/", "repos")).toBe("https://api.github.com/repos");
  });
});

describe("checkAllowedDomains", () => {
  it("returns null when allowedDomains is empty", () => {
    expect(checkAllowedDomains("https://evil.com", [])).toBeNull();
  });

  it("returns null when domain is in list", () => {
    expect(checkAllowedDomains("https://api.github.com/repos", ["api.github.com"])).toBeNull();
  });

  it("returns error when domain is not in list", () => {
    const result = checkAllowedDomains("https://evil.com/data", ["api.github.com"]);
    expect(result).toContain("evil.com");
    expect(result).toContain("not in allowedDomains");
  });

  it("is case-insensitive", () => {
    expect(checkAllowedDomains("https://API.GitHub.COM/repos", ["api.github.com"])).toBeNull();
  });

  it("returns error for invalid URL", () => {
    const result = checkAllowedDomains("not-a-url", ["example.com"]);
    expect(result).toContain("Invalid URL");
  });

  it("allows any of multiple domains", () => {
    expect(checkAllowedDomains("https://b.com/data", ["a.com", "b.com", "c.com"])).toBeNull();
  });
});

describe("HTTP fetch abort integration", () => {
  // One server per test: each test arms a specific handler (e.g. hang
  // forever, drip-feed body) so we know precisely which leg of the
  // fetch is in flight when we abort.
  let server: Server;
  let url: string;
  let pendingResponses: Array<{ end: () => void }> = [];

  afterEach(() => {
    // Force-close anything mid-flight so the server.close() promise
    // resolves promptly even after an aborted fetch. The happy-path
    // test ends its response normally, so a second `.end()` here
    // would throw ERR_STREAM_WRITE_AFTER_END — swallow because we're
    // in test cleanup and only care that the socket is gone.
    for (const r of pendingResponses) {
      try {
        r.end();
      } catch {
        /* already ended; nothing to do */
      }
    }
    pendingResponses = [];
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function startServer(handler: (req: any, res: any) => void): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        pendingResponses.push({ end: () => res.end() });
        handler(req, res);
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        url = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  it("__internal_fetch: rejects with AgencyCancelledError when ctx is cancelled mid-request", async () => {
    // Server that never responds — the fetch hangs on the headers
    // phase, so the AbortSignal we pass to fetch() is what unblocks it.
    await startServer(() => {
      /* never write, never end */
    });
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    const fetchPromise = __internal_fetch(ctx, stack, threads, url, "", {}, []);
    // Give the request a moment to actually open the socket so we
    // exercise the in-flight abort path, not the pre-fetch
    // `signal.aborted === true` shortcut.
    await new Promise((r) => setTimeout(r, 20));
    ctx.cancel("test stop");
    await expect(fetchPromise).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("__internal_fetch: rejects with AgencyCancelledError when a per-branch StateStack signal fires", async () => {
    // Use a per-branch AbortController (the same mechanism runBatch
    // wires up for race losers) and verify that aborting it tears down
    // an in-flight request even though the global ctx is still alive.
    await startServer(() => {
      /* hang */
    });
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const branchAbort = new AbortController();
    stack.abortSignal = branchAbort.signal;
    const threads = new ThreadStore();
    const fetchPromise = __internal_fetch(ctx, stack, threads, url, "", {}, []);
    await new Promise((r) => setTimeout(r, 20));
    branchAbort.abort();
    await expect(fetchPromise).rejects.toBeInstanceOf(AgencyCancelledError);
    expect(ctx.aborted).toBe(false); // global ctx untouched
  });

  it("__internal_fetch: succeeds when no abort fires", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    const body = await __internal_fetch(ctx, stack, threads, url, "", {}, []);
    expect(body).toBe("hello");
  });

  it("__internal_fetchJSON: cancels in-flight request and rejects with AgencyCancelledError", async () => {
    await startServer(() => {
      /* hang */
    });
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    const p = __internal_fetchJSON(ctx, stack, threads, url, "", {}, []);
    await new Promise((r) => setTimeout(r, 20));
    ctx.cancel();
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("__internal_fetchMarkdown: cancels in-flight request and rejects with AgencyCancelledError", async () => {
    await startServer(() => {
      /* hang */
    });
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    const p = __internal_fetchMarkdown(ctx, stack, threads, url, "", {}, []);
    await new Promise((r) => setTimeout(r, 20));
    ctx.cancel();
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("__internal_fetch: aborts a slow body read (cancellation between chunks)", async () => {
    // Server writes headers immediately, then drip-feeds the body so
    // the abort hits the streaming-read path inside readBodyCapped
    // rather than the initial connect. This exercises the
    // signal.addEventListener("abort", () => reader.cancel())
    // wiring specifically.
    await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first-chunk");
      // Never write again — body read stalls.
    });
    const ctx = makeMockCtx();
    const stack = new StateStack();
    const threads = new ThreadStore();
    const p = __internal_fetch(ctx, stack, threads, url, "", {}, []);
    await new Promise((r) => setTimeout(r, 30));
    ctx.cancel();
    await expect(p).rejects.toBeInstanceOf(AgencyCancelledError);
  });
});

describe("readBodyBytesCapped", () => {
  function pendingStreamResponse(firstChunk: Uint8Array): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(firstChunk);
          return new Promise<void>(() => {});
        },
      }),
    );
  }

  it("rejects a pending read on abort instead of returning the prefix", async () => {
    const response = pendingStreamResponse(new Uint8Array([1, 2]));
    const abortController = new AbortController();
    const read = readBodyBytesCapped(
      response,
      "https://example.com/pending",
      abortController.signal,
    );
    abortController.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces a pending-read abort as AgencyCancelledError through runHttp", async () => {
    const integrationUrl = "https://example.com/pending-integration";
    const integrationResponse = pendingStreamResponse(new Uint8Array([3, 4]));
    const integrationAbortController = new AbortController();
    const integratedRead = runHttp(
      () =>
        readBodyBytesCapped(integrationResponse, integrationUrl, integrationAbortController.signal),
      integrationUrl,
    );
    integrationAbortController.abort();
    await expect(integratedRead).rejects.toBeInstanceOf(AgencyCancelledError);
  });

  it("cancels the stream and releases the lock when the signal is already aborted", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array([1, 2]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const abortController = new AbortController();
    abortController.abort();
    await expect(
      readBodyBytesCapped(response, "https://example.com/pre-aborted", abortController.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    // The lock was released in `finally`; a second getReader must not throw.
    expect(() => response.body!.getReader()).not.toThrow();
  });

  it("rejects a body one byte over the cap", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array(AWS_OBJECT_BYTE_LIMIT + 1));
          streamController.close();
        },
      }),
    );
    const abortController = new AbortController();
    await expect(
      readBodyBytesCapped(response, "https://example.com/big", abortController.signal),
    ).rejects.toThrow(/exceeds/);
  });
});
