import { describe, it as baseIt, expect, beforeEach } from "vitest";
import {
  __registerEffectCapabilities,
  effectCapabilitiesFor,
  missingCapabilityFor,
} from "./effectCapabilities.js";
import { interruptWithHandlers, isRejected } from "./interrupts.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { memoryHost } from "../host/memoryHost.js";
import { inFrameOf, withTestFrame } from "./__tests__/testHelpers.js";
import type { Capability } from "../host/host.js";

const it = withTestFrame(baseIt);

// Effect names of their own per test, since the registry is process-wide
// and keeps what a test registered.
let counter = 0;
function freshEffect(needed: Capability[]): string {
  counter += 1;
  const effect = `test::effect${counter}`;
  __registerEffectCapabilities(effect, needed);
  return effect;
}

function makeCtx(capabilities: Capability[]): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
    host: memoryHost({ capabilities }),
  });
}

describe("the effect capabilities registry", () => {
  it("keeps what a declaration registered and answers with a copy", () => {
    const effect = freshEffect(["fileRead", "llm"]);
    const first = effectCapabilitiesFor(effect);
    first.push("env");
    expect(effectCapabilitiesFor(effect)).toEqual(["fileRead", "llm"]);
  });

  it("accepts the same list again, in any order, and refuses a different one", () => {
    const effect = freshEffect(["fileRead", "network"]);
    expect(() => __registerEffectCapabilities(effect, ["network", "fileRead"])).not.toThrow();
    expect(() => __registerEffectCapabilities(effect, ["subprocess"])).toThrow(
      /two different @capabilities lists/,
    );
  });

  it("names the first capability the host lacks, or null", () => {
    const effect = freshEffect(["env", "subprocess"]);
    expect(missingCapabilityFor(memoryHost({ capabilities: ["env"] }), effect)).toBe("subprocess");
    expect(missingCapabilityFor(memoryHost({ capabilities: ["env", "subprocess"] }), effect)).toBe(
      null,
    );
    expect(missingCapabilityFor(memoryHost({ capabilities: [] }), "test::unregistered")).toBe(null);
  });
});

describe("refusing a raise the host cannot serve", () => {
  let handlerRan = 0;
  beforeEach(() => {
    handlerRan = 0;
  });

  it("rejects before any handler runs, naming the capability", async () => {
    const effect = freshEffect(["subprocess"]);
    const ctx = makeCtx(["env"]);
    ctx.handlers = [
      {
        fn: async () => {
          handlerRan += 1;
          return { type: "approve" as const };
        },
        liveGuardIds: [],
      },
    ];
    const verdict = await inFrameOf(ctx, new StateStack(), (run) =>
      interruptWithHandlers(run, effect, "run it?", {}, "o"),
    );
    expect(isRejected(verdict)).toBe(true);
    expect((verdict as { value: string }).value).toBe(
      `${effect} needs the subprocess capability, which the memory host does not have.`,
    );
    expect(handlerRan).toBe(0);
  });

  it("still runs a handler, which can still reject, for an effect the host serves", async () => {
    const effect = freshEffect(["env"]);
    const ctx = makeCtx(["env"]);
    ctx.handlers = [
      {
        fn: async () => {
          handlerRan += 1;
          return { type: "reject" as const, value: "not today" };
        },
        liveGuardIds: [],
      },
    ];
    const verdict = await inFrameOf(ctx, new StateStack(), (run) =>
      interruptWithHandlers(run, effect, "read it?", {}, "o"),
    );
    expect(handlerRan).toBe(1);
    expect(verdict).toEqual({ type: "reject", value: "not today" });
  });
});
