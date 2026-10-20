import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { freshImport, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

const agencyFile = path.join(fixtureDir, "question.agency");
const compiledFile = path.join(fixtureDir, "question.ts");

beforeAll(() => {
  compile({ debugger: true }, agencyFile, compiledFile, { ts: true });
});

async function questionSession(node = "main") {
  const mod = await freshImport(compiledFile);
  return await DebuggerTestSession.create({ mod: { ...mod, main: mod[node] } });
}

function activity(session: DebuggerTestSession): string[] {
  return session.ui.state.getActivityLog();
}

describe("a question in the debugger", () => {
  it("shows the question and takes the typed text as the answer", async () => {
    const session = await questionSession();
    await session.press("c");
    expect(activity(session)).toContainEqual("Question: What is your name?");
    await session.type("Adit");
    expect(activity(session)).toContainEqual('Answered: "Adit"');
    expect(await session.quit()).toBe("Hello, Adit");
  });

  it("asks again on an empty answer, and reject rejects", async () => {
    const session = await questionSession("pick");
    await session.press("c");
    await session.type("");
    expect(activity(session)).toContainEqual("Type the answer, or reject");
    await session.type("reject");
    expect(await session.quit()).toMatchObject({ success: false });
  });

  it("a plain raise used as a value takes text, or JSON through resolve", async () => {
    const asText = await questionSession("pick");
    await asText.press("c");
    expect(activity(asText)).toContainEqual("Question: Pick a number");
    await asText.type("seven");
    expect(await asText.quit()).toBe("seven");

    const asJson = await questionSession("pick");
    await asJson.press("c");
    await asJson.type("resolve 7");
    expect(await asJson.quit()).toBe(7);
  });
});
