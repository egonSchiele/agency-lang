import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { nodeHost } from "../host/node/nodeHost.js";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { postLocalJson, explainNoServer, CANCELLED } from "./localRequest.js";

const { network } = nodeHost();

describe("postLocalJson", () => {
  // A stand-in for the local model server. `respond` is set by each test
  // and decides what happens to a request once its body has arrived.
  let server: http.Server;
  let baseUrl = "";
  let received: string[] = [];
  let respond: (res: http.ServerResponse) => void = () => {};
  let onRequest: () => void = () => {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        received.push(req.url ?? "");
        respond(res);
        onRequest();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function answerWith(status: number, body: string) {
    received = [];
    onRequest = () => {};
    respond = (res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
  }

  /** Resolves once the server has the next request in hand. */
  function nextRequest(): Promise<void> {
    return new Promise((resolve) => {
      onRequest = resolve;
    });
  }

  const LONG_MS = 60_000;

  it("posts to the address it is given and returns the parsed reply", async () => {
    answerWith(200, '{"tags":[]}');
    const out = await postLocalJson(network, "/vision/tags", { model: "m" }, LONG_MS, "vision", {
      baseUrl,
    });
    expect(out).toEqual({ reply: { tags: [] } });
    expect(received).toEqual(["/v1/vision/tags"]);
  });

  it("returns the server's own message for a refusal", async () => {
    answerWith(400, '{"error":{"message":"steps must be at most 50."}}');
    const out = await postLocalJson(network, "/x", {}, LONG_MS, "image", { baseUrl });
    expect(out).toEqual({ error: "steps must be at most 50." });
  });

  it("names the server when a reply is not JSON, or is a refusal with no message", async () => {
    answerWith(500, "oops");
    expect(await postLocalJson(network, "/x", {}, LONG_MS, "image", { baseUrl })).toEqual({
      error: "The image server answered 500 with a body that is not JSON.",
    });
    answerWith(503, "{}");
    expect(await postLocalJson(network, "/x", {}, LONG_MS, "vision", { baseUrl })).toEqual({
      error: "The vision server answered 503.",
    });
  });

  it("returns Cancelled and sends nothing when the signal was aborted before the call", async () => {
    answerWith(200, "{}");
    const controller = new AbortController();
    controller.abort();
    const out = await postLocalJson(network, "/x", {}, LONG_MS, "image", {
      baseUrl,
      signal: controller.signal,
    });
    expect(out).toEqual({ error: CANCELLED });
    expect(received).toEqual([]);
  });

  it("returns Cancelled when the caller aborts while the server holds the request", async () => {
    received = [];
    respond = () => {};
    const arrived = nextRequest();
    const controller = new AbortController();
    const pending = postLocalJson(network, "/x", {}, LONG_MS, "image", {
      baseUrl,
      signal: controller.signal,
    });
    await arrived;
    controller.abort();
    expect(await pending).toEqual({ error: CANCELLED });
  });

  it("returns Cancelled when the caller aborts while the reply's body is arriving", async () => {
    received = [];
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":[');
    };
    const arrived = nextRequest();
    const controller = new AbortController();
    const pending = postLocalJson(network, "/x", {}, LONG_MS, "image", {
      baseUrl,
      signal: controller.signal,
    });
    await arrived;
    // Give the headers and the first half of the body time to arrive, so
    // the abort lands in the body read and not in the fetch.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    expect(await pending).toEqual({ error: CANCELLED });
  });

  it("keeps the timeout's own message when the request runs out of time", async () => {
    received = [];
    respond = () => {};
    onRequest = () => {};
    const out = await postLocalJson(network, "/x", {}, 50, "image", {
      baseUrl,
      signal: new AbortController().signal,
    });
    expect("error" in out && out.error).toMatch(/timeout/i);
    expect("error" in out && out.error).not.toBe(CANCELLED);
  });
});

describe("explainNoServer", () => {
  it("says how to start a server when the error means none is running", () => {
    expect(
      explainNoServer(
        "fetch failed (ECONNREFUSED)",
        "http://127.0.0.1:9/v1",
        "agency local serve m",
      ),
    ).toBe(
      "no local model server answered at http://127.0.0.1:9/v1. Start one with:\n  agency local serve m",
    );
  });

  it("leaves any other error as it is", () => {
    expect(
      explainNoServer("steps must be at most 50.", "http://x/v1", "agency local serve m"),
    ).toBe("steps must be at most 50.");
  });
});
