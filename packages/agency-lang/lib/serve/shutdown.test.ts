import { describe, it, expect, vi, afterEach } from "vitest";
import type http from "http";
import { exitOnShutdownSignal } from "./shutdown.js";
import { sendStatelogPost } from "../statelogSender.js";

type SignalHandlers = Record<string, () => void>;

/** Record the handlers `exitOnShutdownSignal` installs, without installing
 *  them on the test process. */
function captureSignalHandlers(): SignalHandlers {
  const handlers: SignalHandlers = {};
  vi.spyOn(process, "on").mockImplementation(((signal: string, handler: () => void) => {
    handlers[signal] = handler;
    return process;
  }) as never);
  return handlers;
}

describe("exitOnShutdownSignal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("on SIGTERM stops the server, waits for pending logs, then exits 0", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const handlers = captureSignalHandlers();
    const close = vi.fn();
    exitOnShutdownSignal({ close } as unknown as http.Server);

    // The log of the last request, still on its way.
    sendStatelogPost({
      host: "https://example.invalid",
      projectId: "p",
      apiKey: "secret",
      body: "{}",
      timeoutMs: 60_000,
      debugMode: false,
    });
    handlers.SIGTERM();
    expect(close).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitSpy).not.toHaveBeenCalled();

    resolveFetch(new Response("", { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("handles SIGINT the same way, and a second signal does nothing more", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const handlers = captureSignalHandlers();
    const close = vi.fn();
    exitOnShutdownSignal({ close } as unknown as http.Server);

    handlers.SIGINT();
    handlers.SIGTERM();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("works with no server, for the stdio MCP server", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const handlers = captureSignalHandlers();
    exitOnShutdownSignal();
    handlers.SIGTERM();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
