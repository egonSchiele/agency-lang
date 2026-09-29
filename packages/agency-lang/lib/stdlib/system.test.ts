import { describe, it, expect, vi, afterEach } from "vitest";
import { _exit, _urlHost } from "./system.js";
import { StatelogClient } from "../statelogClient.js";

describe("_urlHost", () => {
  it("returns the hostname of a URL", () => {
    expect(_urlHost("https://example.com/a/b?c=d")).toBe("example.com");
  });

  it("returns the whole string when there is no hostname", () => {
    expect(_urlHost("not a url")).toBe("not a url");
    expect(_urlHost("mailto:user@example.com")).toBe("mailto:user@example.com");
  });
});

describe("_exit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for log POSTs still in flight before exiting", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const client = new StatelogClient({
      host: "https://example.invalid",
      apiKey: "secret",
      projectId: "p",
      traceId: "t",
      observability: true,
      requestTimeoutMs: 60_000,
    });
    await client.debug("last event", {});

    const exiting = _exit(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitSpy).not.toHaveBeenCalled();

    resolveFetch(new Response("", { status: 200 }));
    await exiting;
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
