import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

// The logger now routes through `console.*` so that an active
// `std::ui.repl()` capture (which monkeypatches the console sinks)
// can funnel output into the on-screen transcript instead of having
// raw `stderr.write` corrupt the rendered frame. Tests spy on
// `console.error` / `.warn` / etc. to verify dispatch.

type ConsoleMethod = "error" | "warn" | "info" | "debug";

describe("createLogger", () => {
  const spies: Record<ConsoleMethod, ReturnType<typeof vi.spyOn>> = {
    error: undefined as any,
    warn: undefined as any,
    info: undefined as any,
    debug: undefined as any,
  };

  beforeEach(() => {
    spies.error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    spies.warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    spies.info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    spies.debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    spies.error.mockRestore();
    spies.warn.mockRestore();
    spies.info.mockRestore();
    spies.debug.mockRestore();
  });

  function totalCalls(): number {
    return (
      spies.error.mock.calls.length +
      spies.warn.mock.calls.length +
      spies.info.mock.calls.length +
      spies.debug.mock.calls.length
    );
  }

  it("logs at info level by default", () => {
    const log = createLogger("info");
    log.info("hello");
    expect(spies.info).toHaveBeenCalledTimes(1);
    expect(spies.info.mock.calls[0][0] as string).toContain("hello");
  });

  it("routes each level to the matching console.* sink", () => {
    const log = createLogger("debug");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.info).toHaveBeenCalledTimes(1);
    expect(spies.debug).toHaveBeenCalledTimes(1);
  });

  it("suppresses debug when level is info", () => {
    const log = createLogger("info");
    log.debug("hidden");
    expect(totalCalls()).toBe(0);
  });

  it("shows debug when level is debug", () => {
    const log = createLogger("debug");
    log.debug("visible");
    expect(spies.debug).toHaveBeenCalledTimes(1);
  });

  it("suppresses info when level is warn", () => {
    const log = createLogger("warn");
    log.warn("caution");
    expect(spies.warn).toHaveBeenCalledTimes(1);
    log.info("suppressed");
    expect(totalCalls()).toBe(1);
  });

  it("suppresses warn when level is error", () => {
    const log = createLogger("error");
    log.error("bad");
    expect(spies.error).toHaveBeenCalledTimes(1);
    log.warn("suppressed");
    expect(totalCalls()).toBe(1);
  });

  it("includes level label in output", () => {
    const log = createLogger("debug");
    log.warn("test");
    expect(spies.warn.mock.calls[0][0] as string).toContain("WARN");
  });
});
