import { describe, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

const stepTestAgency = path.join(fixtureDir, "step-test.agency");
const stepTestCompiled = path.join(fixtureDir, "step-test.ts");
const fnCallAgency = path.join(fixtureDir, "function-call-test.agency");
const fnCallCompiled = path.join(fixtureDir, "function-call-test.ts");

beforeAll(() => {
  compile({ debugger: true }, stepTestAgency, stepTestCompiled, { ts: true });
  compile({ debugger: true }, fnCallAgency, fnCallCompiled, { ts: true });
});

describe("Export frames for visual inspection", () => {
  it("step-test: step through each statement", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    await session.press("s"); // past y = 2
    await session.press("s"); // past z = x + y
    await session.press("c"); // continue to completion

    const outPath = path.resolve("test-frames/step-test-frames.html");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    session.writeHTML(outPath);
    console.log(`Wrote ${session.recorder.frames.length} frames to ${outPath}`);
  });

  it("function-call-test: stepIn into a function", async () => {
    const mod = await freshImport(fnCallCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // x = 1
    await session.press("s"); // at y = add(x, 2)
    await session.press("i"); // stepIn to add()
    await session.press("s"); // inside add
    await session.press("s"); // inside add
    await session.press("s"); // back in main
    await session.press("c"); // continue

    const outPath = path.resolve("test-frames/function-call-frames.html");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    session.writeHTML(outPath);
    console.log(`Wrote ${session.recorder.frames.length} frames to ${outPath}`);
  });
});
