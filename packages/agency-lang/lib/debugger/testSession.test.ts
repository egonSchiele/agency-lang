import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

const stepTestAgency = path.join(fixtureDir, "step-test.agency");
const stepTestCompiled = path.join(fixtureDir, "step-test.ts");

beforeAll(() => {
  compile({ debugger: true }, stepTestAgency, stepTestCompiled, { ts: true });
});

describe("DebuggerTestSession", () => {
  it("steps through and returns correct value", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    // step-test.agency: x = 1, y = 2, z = x + y, return z
    await session.press("s", { times: 10 });
    await session.press("c");
    const result = await session.quit();

    expect(result).toBe(3);
  });

  it("frame inspection works", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    const frame = session.frame();
    expect(frame).toBeDefined();
    const localsPane = frame.findByKey("locals");
    expect(localsPane).toBeDefined();
    expect(localsPane!.toPlainText()).toContain("x");
  });

  it("continue runs to completion", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("c");
    const result = await session.quit();

    expect(result).toBe(3);
  });

  it("writeHTML produces output file", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s");
    await session.press("c");

    const outPath = path.join(fixtureDir, "__test-output.html");
    session.writeHTML(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    fs.unlinkSync(outPath);
  });
});
