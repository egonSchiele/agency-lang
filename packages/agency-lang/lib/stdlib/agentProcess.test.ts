import { describe, expect, it } from "vitest";
import { _setTraceOptions, _traceOptions } from "./agentProcess.js";

describe("trace options", () => {
  it("start as an interactive run with no tracing", () => {
    expect(_traceOptions()).toEqual({
      debug: false,
      verbose: false,
      interactive: true,
    });
  });

  it("are the process's: any reader sees what was set", () => {
    _setTraceOptions({ debug: false, verbose: true, interactive: false });
    expect(_traceOptions().verbose).toBe(true);
    _setTraceOptions({ debug: false, verbose: false, interactive: true });
  });
});
