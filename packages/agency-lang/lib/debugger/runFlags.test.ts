import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";
import type { InvocationOptions } from "@/runtime/invocationOptions.js";

const agencyFile = path.join(fixtureDir, "interrupt-test.agency");
const compiledFile = path.join(fixtureDir, "interrupt-test.ts");
const topLevelAgencyFile = path.join(fixtureDir, "top-level-interrupt.agency");
const topLevelCompiledFile = path.join(fixtureDir, "top-level-interrupt.ts");

beforeAll(() => {
  compile({}, agencyFile, compiledFile, { ts: true });
  compile({}, topLevelAgencyFile, topLevelCompiledFile, { ts: true });
});

const rejectAll: InvocationOptions = { policy: { "*": [{ action: "reject" }] } };
const approveAll: InvocationOptions = { policy: { "*": [{ action: "approve" }] } };

// interrupt-test: x = 1, y = interrupt("check value"), z = x + y, return z
describe("a debugged run under a policy", () => {
  it("the policy answers the interrupt, so the debugger never asks", async () => {
    const mod = await freshImport(compiledFile);
    const session = await DebuggerTestSession.create({ mod, invocation: rejectAll });
    await session.press("c");
    const log = session.ui.state.getActivityLog();
    expect(log.some((line) => line.startsWith("Question"))).toBe(false);
    expect(await session.quit()).toMatchObject({ success: false });
  });

  it("a rewind installs the policy again", async () => {
    const mod = await freshImport(compiledFile);
    const session = await DebuggerTestSession.create({ mod, invocation: rejectAll });
    await session.press("s"); // past x = 1
    await session.press("s"); // the interrupt, rejected by the policy
    await session.press("up"); // back before it
    await session.press("c");
    const log = session.ui.state.getActivityLog();
    expect(log.some((line) => line.startsWith("Rewinding to checkpoint"))).toBe(true);
    expect(log.some((line) => line.startsWith("Question"))).toBe(false);
    expect(await session.quit()).toMatchObject({ success: false });
  });

  // top-level-interrupt: the interrupt is raised before the first debug
  // stop, on the leg that starts the run. Only the node call carries the
  // policy there; a resume never sees that leg. (The runtime logs that it
  // cannot checkpoint a top-level interrupt; the policy answers it anyway.)
  it("the policy covers the leg before the first stop", async () => {
    const mod = await freshImport(topLevelCompiledFile);
    const session = await DebuggerTestSession.create({ mod, invocation: approveAll });
    await session.press("c");
    const log = session.ui.state.getActivityLog();
    expect(log.some((line) => line.startsWith("Question"))).toBe(false);
    expect(await session.quit()).toBe(1);
  });

  it("the budget is a root guard on the first checkpoint", async () => {
    const mod = await freshImport(compiledFile);
    const session = await DebuggerTestSession.create({
      mod,
      invocation: { config: { budget: { maxCost: 2 } } },
    });
    const first = session.driver.debuggerState.getCheckpoints().at(-1);
    expect(first?.toJSON().stack.guards).toMatchObject([
      { kind: "cost", costLimit: 2, isRootBudget: true },
    ]);
    await session.quit();
  });
});
