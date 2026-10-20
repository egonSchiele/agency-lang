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
    expect((globalThis as any).__agencyInputOverride).toBeUndefined();
    await session.press("c");
    await session.type("Adit");
    expect((globalThis as any).__agencyInputOverride).toBeUndefined();
    expect(await session.quit()).toBe("Hello, Adit");
  });
});
