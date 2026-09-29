import { describe, it, expect, vi, afterEach } from "vitest";
import { exitProcess, exitProcessNow } from "./exitProcess.js";
import { sendStatelogPost } from "../statelogSender.js";

const POST = {
  url: "https://example.invalid/api/logs",
  apiKey: "secret",
  body: "{}",
  timeoutMs: 60_000,
  debugMode: false,
};

describe("exitProcess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for a log request still on its way, then exits with the code", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    sendStatelogPost(POST);

    const exiting = exitProcess(3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitSpy).not.toHaveBeenCalled();

    resolveFetch(new Response("", { status: 200 }));
    await exiting;
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("still exits when the request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    sendStatelogPost(POST);
    await exitProcess(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("exitProcessNow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits without waiting for a log request", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    sendStatelogPost(POST);
    exitProcessNow(130);
    expect(exitSpy).toHaveBeenCalledWith(130);
    // Settle the request so it does not stay pending for later tests.
    resolveFetch(new Response("", { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
