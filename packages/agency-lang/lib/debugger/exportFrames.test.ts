import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

const stepTestAgency = path.join(fixtureDir, "step-test.agency");
const stepTestCompiled = path.join(fixtureDir, "step-test.ts");
const fnCallAgency = path.join(fixtureDir, "function-call-test.agency");
const fnCallCompiled = path.join(fixtureDir, "function-call-test.ts");

const framesDir = path.join(fixtureDir, "..", "test-frames");

beforeAll(() => {
  compile({ debugger: true }, stepTestAgency, stepTestCompiled, { ts: true });
  compile({ debugger: true }, fnCallAgency, fnCallCompiled, { ts: true });
});

// These tests generate HTML frame exports for visual debugging.
// Run with EXPORT_FRAMES=1 to write HTML files; otherwise they just
// verify the session records frames without writing artifacts.
const shouldExport = !!process.env.EXPORT_FRAMES;

describe("Export frames for visual inspection", () => {
  it("step-test: step through each statement", async () => {
    const mod = await freshImport(stepTestCompiled);
    const session = await DebuggerTestSession.create({ mod });

    await session.press("s"); // past x = 1
    await session.press("s"); // past y = 2
    await session.press("s"); // past z = x + y
    await session.press("c"); // continue to completion

    expect(session.recorder.frames.length).toBeGreaterThan(0);

    if (shouldExport) {
      const outPath = path.join(framesDir, "step-test-frames.html");
      fs.mkdirSync(framesDir, { recursive: true });
      session.writeHTML(outPath);
    }
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

    expect(session.recorder.frames.length).toBeGreaterThan(0);

    if (shouldExport) {
      const outPath = path.join(framesDir, "function-call-frames.html");
      fs.mkdirSync(framesDir, { recursive: true });
      session.writeHTML(outPath);
    }
  });
});
