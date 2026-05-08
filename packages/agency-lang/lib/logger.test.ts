import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => spy.mockRestore());

  it("logs at info level by default", () => {
    const log = createLogger("info");
    log.info("hello");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0] as string).toContain("hello");
  });

  it("suppresses debug when level is info", () => {
    const log = createLogger("info");
    log.debug("hidden");
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows debug when level is debug", () => {
    const log = createLogger("debug");
    log.debug("visible");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("suppresses info when level is warn", () => {
    const log = createLogger("warn");
    log.warn("caution");
    expect(spy).toHaveBeenCalledTimes(1);
    log.info("suppressed");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("suppresses warn when level is error", () => {
    const log = createLogger("error");
    log.error("bad");
    expect(spy).toHaveBeenCalledTimes(1);
    log.warn("suppressed");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("includes level label in output", () => {
    const log = createLogger("debug");
    log.warn("test");
    expect(spy.mock.calls[0][0] as string).toContain("WARN");
  });
});
