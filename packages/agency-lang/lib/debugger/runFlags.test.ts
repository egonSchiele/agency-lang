import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

const agencyFile = path.join(fixtureDir, "interrupt-test.agency");
const compiledFile = path.join(fixtureDir, "interrupt-test.ts");

beforeAll(() => {
  compile({ debugger: true }, agencyFile, compiledFile, { ts: true });
});

// interrupt-test: x = 1, y = interrupt("check value"), z = x + y, return z
describe("a debugged run under a policy", () => {
  it("the policy answers the interrupt, so the debugger never asks", async () => {
    const mod = await freshImport(compiledFile);
    const session = await DebuggerTestSession.create({
      mod,
      invocation: { policy: { "*": [{ action: "reject" }] } },
    });
    await session.press("c");
    const log = session.ui.state.getActivityLog();
    expect(log.some((line) => line.startsWith("Question"))).toBe(false);
    expect(await session.quit()).toMatchObject({ success: false });
  });

  it("a rewind installs the policy again", async () => {
    const mod = await freshImport(compiledFile);
    const session = await DebuggerTestSession.create({
      mod,
      invocation: { policy: { "*": [{ action: "reject" }] } },
    });
    await session.press("s"); // past x = 1
    await session.press("s"); // the interrupt, rejected by the policy
    await session.press("up"); // back before it
    await session.press("c");
    const log = session.ui.state.getActivityLog();
    expect(log.some((line) => line.startsWith("Question"))).toBe(false);
    expect(await session.quit()).toMatchObject({ success: false });
  });
});
