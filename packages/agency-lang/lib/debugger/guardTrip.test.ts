import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { freshImport, fixtureDir, withLLMMocks } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";
import type { LLMMock } from "../runtime/deterministicClient.js";

const agencyFile = path.join(fixtureDir, "guard-trip.agency");
const compiledFile = path.join(fixtureDir, "guard-trip.ts");

beforeAll(() => {
  compile({}, agencyFile, compiledFile, { ts: true });
});

const mocks: LLMMock[] = [{ return: "one" }, { return: "two" }];

async function guardSession() {
  const mod = await freshImport(compiledFile);
  return await DebuggerTestSession.create({ mod });
}

function activity(session: DebuggerTestSession): string[] {
  return session.ui.state.getActivityLog();
}

function screen(session: DebuggerTestSession): string {
  return session.frame().toPlainText();
}

describe("a guard trip in the debugger", () => {
  it("offers the three answers, refuses a grant too small to clear the trip, then approves", async () => {
    await withLLMMocks(mocks, async () => {
      const session = await guardSession();
      // Inside the guard block, before the trip, the guards pane lists
      // the guard against its limit. (A form overlay draws only the
      // source and locals rows above itself, so the pane is checked here.)
      for (
        let i = 0;
        i < 5 && !(session.frame().findByKey("guards")?.toPlainText() ?? "").includes("research");
        i++
      ) {
        await session.press("s");
      }
      expect(session.frame().findByKey("guards")!.toPlainText()).toContain(
        "research · cost $0 of $0.000001",
      );
      await session.press("c");
      expect(activity(session)).toContainEqual(
        'Guard "research" tripped on cost: $0.000002 spent of $0.000001',
      );
      expect(screen(session)).toContain('A reject may return the saved draft: "draft"');
      expect(screen(session)).toContain("> Approve with more budget");
      expect(screen(session)).toContain("Remove the cost limit");
      // The guards pane lists the tripped guard against its limit.
      expect(session.ui.state.listGuards()).toEqual([
        {
          label: "research",
          dimension: "cost",
          limit: 0.000001,
          spent: 0.000002,
          disarmed: false,
          root: false,
          inherited: false,
        },
      ]);
      // The source pane shows the llm() statement the trip happened under.
      expect(session.frame().findByKey("source")!.toPlainText()).toMatch(
        /│>\s+\d+\s+.*llm\("first"\)/,
      );
      await session.press("enter");
      expect(screen(session)).toContain("How much more cost? ($) >");
      await session.type("0.0000001");
      expect(screen(session)).toContain("must be more than $0.000001");
      await session.type("1");
      expect(screen(session)).toContain("Message to the model (optional) >");
      await session.type("finish up");
      expect(activity(session)).toContainEqual(
        'Approved the guard trip with {"maxCost":1,"message":"finish up"}',
      );
      expect(JSON.stringify(await session.quit())).toContain("onetwo");
    });
  });

  it("removing the limit lets the work finish", async () => {
    await withLLMMocks(mocks, async () => {
      const session = await guardSession();
      await session.press("c");
      await session.press("down");
      await session.press("enter");
      await session.type("");
      expect(activity(session)).toContainEqual('Approved the guard trip with {"disarm":["cost"]}');
      expect(JSON.stringify(await session.quit())).toContain("onetwo");
    });
  });

  it("a reject returns the saved draft", async () => {
    await withLLMMocks(mocks, async () => {
      const session = await guardSession();
      await session.press("c");
      await session.press("down", { times: 2 });
      await session.press("enter");
      expect(activity(session)).toContainEqual("Rejected the guard trip");
      const result = JSON.stringify(await session.quit());
      expect(result).toContain('"draft"');
      expect(result).not.toContain("onetwo");
    });
  });

  it("escape in a field goes back to the choices", async () => {
    await withLLMMocks(mocks, async () => {
      const session = await guardSession();
      await session.press("c");
      await session.press("enter");
      await session.press("escape");
      expect(screen(session)).toContain("> Approve with more budget");
      await session.press("down", { times: 2 });
      await session.press("enter");
      expect(activity(session)).toContainEqual("Rejected the guard trip");
    });
  });
});
