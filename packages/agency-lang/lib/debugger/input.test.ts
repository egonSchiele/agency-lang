import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

const agencyFile = path.join(fixtureDir, "input-test.agency");
const compiledFile = path.join(fixtureDir, "input-test.ts");

beforeAll(() => {
  compile({}, agencyFile, compiledFile, { ts: true });
});

describe("input() under the debugger", () => {
  it("is answered in the text field, through the invocation and not a process global", async () => {
    const mod = await freshImport(compiledFile);
    const session = await DebuggerTestSession.create({ mod });
    await session.press("c");
    await session.type("Adit");
    expect(await session.quit()).toBe("Hello, Adit");
  });

  // Outside the debugger there is no resume: the override reaches the
  // run only because the generated node function forwards the
  // `inputOverride` option to `runNode`.
  it("reaches a plain node call through the invocation option", async () => {
    const mod = await freshImport(compiledFile);
    const prompts: string[] = [];
    const result = await mod.main({
      inputOverride: async (prompt: string) => {
        prompts.push(prompt);
        return "Adit";
      },
    });
    expect(result.data).toBe("Hello, Adit");
    expect(prompts).toHaveLength(1);
  });
});
