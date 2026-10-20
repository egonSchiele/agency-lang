import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { freshImport, fixtureDir, withLLMMocks } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";
import type { LLMMock } from "../runtime/deterministicClient.js";

const agencyFile = path.join(fixtureDir, "guard-trip.agency");
const compiledFile = path.join(fixtureDir, "guard-trip.ts");

beforeAll(() => {
  compile({ debugger: true }, agencyFile, compiledFile, { ts: true });
});

const mocks: LLMMock[] = [{ return: "one" }, { return: "two" }];

async function guardSession() {
  const mod = await freshImport(compiledFile);
  return await DebuggerTestSession.create({ mod });
}

function activity(session: DebuggerTestSession): string[] {
  return session.ui.state.getActivityLog();
}

describe("a guard trip in the debugger", () => {
  it("shows the trip and the draft, and a grant lets the work finish", async () => {
    await withLLMMocks(mocks, async () => {
      const session = await guardSession();
      await session.press("c");
      expect(activity(session)).toContainEqual(
        'Guard "research" tripped on cost: $0.000002 spent of $0.000001',
      );
      expect(activity(session)).toContainEqual('Draft a reject returns: "draft"');
      // The source pane shows the llm() statement the trip happened under.
      expect(session.frame().findByKey("source")!.toPlainText()).toMatch(
        /│>\s+\d+\s+.*llm\("first"\)/,
      );
      await session.type("grant cost 1");
      expect(activity(session)).toContainEqual('Approved the guard trip with {"maxCost":1}');
      expect(JSON.stringify(await session.quit())).toContain("onetwo");
    });
  });

  it("a reject returns the saved draft", async () => {
    await withLLMMocks(mocks, async () => {
      const session = await guardSession();
      await session.press("c");
      await session.type("reject");
      const result = JSON.stringify(await session.quit());
      expect(result).toContain('"draft"');
      expect(result).not.toContain("onetwo");
    });
  });

  it("asks again after an answer the runtime would refuse", async () => {
    await withLLMMocks(mocks, async () => {
      const session = await guardSession();
      await session.press("c");
      await session.type("message keep it short");
      expect(activity(session).some((line) => line.includes("needs a grant or a disarm"))).toBe(
        true,
      );
      await session.type("disarm cost message keep it short");
      expect(JSON.stringify(await session.quit())).toContain("onetwo");
    });
  });
});
