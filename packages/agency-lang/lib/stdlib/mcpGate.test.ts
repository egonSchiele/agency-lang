import { describe, it, expect, vi } from "vitest";
import { agency } from "../runtime/agency.js";
import { approve, reject } from "../runtime/interrupts.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { makeMockCtx } from "../runtime/__tests__/testHelpers.js";
import { gate } from "./mcpGate.js";

function inFrame<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = makeMockCtx();
  return agency.withTestContext(
    { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
    fn,
  );
}

// Run `gated(...)` under an optional handler, inside an outer scope/step so the
// no-handler case exercises the real propagate path the agent could hit.
function callGated(
  gated: ReturnType<typeof gate>,
  handler: null | (() => Promise<any>),
): Promise<any> {
  return inFrame(() =>
    agency.withResumableScope({ name: "outer" }, async (s) =>
      s.step(async () => {
        const invoke = () => gated("github", "create_pr", { title: "x" });
        return handler ? agency.withHandler(handler, invoke) : invoke();
      }),
    ),
  );
}

describe("gate (fail-closed)", () => {
  it("calls the real tool ONLY on explicit approve", async () => {
    const real = vi.fn(async () => "RESULT");
    const out = await callGated(gate(real), async () => approve("ok"));
    expect(real).toHaveBeenCalledWith("github", "create_pr", { title: "x" });
    expect(out).toBe("RESULT");
  });

  it("does NOT call the real tool on reject", async () => {
    const real = vi.fn(async () => "RESULT");
    const out = await callGated(gate(real), async () => reject("denied"));
    expect(real).not.toHaveBeenCalled();
    expect(out).toContain("not approved");
  });

  it("does NOT call the real tool when NO handler resolves (fail-closed)", async () => {
    const real = vi.fn(async () => "RESULT");
    await callGated(gate(real), null);
    expect(real).not.toHaveBeenCalled();
  });
});
