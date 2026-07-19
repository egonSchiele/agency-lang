import { describe, it, expect, afterEach } from "vitest";
import { RuntimeContext } from "./context.js";
import { FakeClock, realClock, type Clock } from "../clock.js";

function makeCtx(clock?: Clock): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
    clock,
  });
}

describe("RuntimeContext.clock", () => {
  const saved = process.env.AGENCY_FAKE_CLOCK;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENCY_FAKE_CLOCK;
    else process.env.AGENCY_FAKE_CLOCK = saved;
  });

  it("defaults to the real clock", () => {
    delete process.env.AGENCY_FAKE_CLOCK;
    expect(makeCtx().clock).toBe(realClock);
  });

  it("installs a FakeClock when AGENCY_FAKE_CLOCK is set", () => {
    process.env.AGENCY_FAKE_CLOCK = "1";
    expect(makeCtx().clock).toBeInstanceOf(FakeClock);
  });

  it("an explicit clock arg wins over the env var", () => {
    process.env.AGENCY_FAKE_CLOCK = "1";
    const explicit = new FakeClock();
    expect(makeCtx(explicit).clock).toBe(explicit);
  });
});
