import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { freshImport, fixtureDir, recordingResumes, type RecordedResume } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

const agencyFile = path.join(fixtureDir, "parallel-interrupts.agency");
const compiledFile = path.join(fixtureDir, "parallel-interrupts.ts");

beforeAll(() => {
  compile({}, agencyFile, compiledFile, { ts: true });
});

/** A session on the fixture that records every resume the driver sends. */
async function batchSession() {
  const mod = await freshImport(compiledFile);
  const resumes: RecordedResume[] = [];
  const session = await DebuggerTestSession.create({ mod: recordingResumes(mod, resumes) });
  return { session, resumes };
}

function activity(session: DebuggerTestSession): string[] {
  return session.ui.state.getActivityLog();
}

describe("a batch of interrupts", () => {
  it("asks about each interrupt in turn and answers the batch in one resume", async () => {
    const { session, resumes } = await batchSession();
    await session.press("c");
    expect(activity(session)).toContainEqual("Interrupt (1 of 2): A?");
    await session.type("resolve 1");
    expect(activity(session)).toContainEqual("Interrupt (2 of 2): B?");
    await session.type("resolve 2");
    expect(await session.quit()).toEqual(["A:1", "B:2"]);
    const answered = resumes.filter((resume) => resume.interrupts === 2);
    expect(answered).toHaveLength(1);
    expect(answered[0].responses).toEqual([
      { type: "approve", value: 1 },
      { type: "approve", value: 2 },
    ]);
  });

  it("the program sees one arm approved and the other rejected", async () => {
    const { session } = await batchSession();
    await session.press("c");
    await session.type("approve");
    await session.type("reject");
    const result = await session.quit();
    expect(result[0]).toMatch(/^A:/);
    expect(result[1]).toMatchObject({ success: false });
  });

  it("asks again after an answer it does not understand", async () => {
    const { session } = await batchSession();
    await session.press("c");
    await session.type("maybe");
    expect(activity(session)).toContainEqual(
      'Unknown response: "maybe". Try: approve, reject, resolve <value>',
    );
    await session.type("resolve 1");
    await session.type("resolve 2");
    expect(await session.quit()).toEqual(["A:1", "B:2"]);
  });
});
