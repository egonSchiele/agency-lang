// Edits on the pane rows, driven headlessly: the composer under the
// thread, the row cursor and Enter on a local, the preview, the
// footer, and what the program then does.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { freshImport, fixtureDir, withLLMMocks } from "../testHelpers.js";
import { DebuggerTestSession } from "../testSession.js";
import type { LLMMock } from "../../runtime/deterministicClient.js";

const agentAgency = path.join(fixtureDir, "agent-shaped.agency");
const agentCompiled = path.join(fixtureDir, "agent-shaped.ts");
const guardAgency = path.join(fixtureDir, "guard-trip.agency");
const guardCompiled = path.join(fixtureDir, "guard-trip.ts");
const forkAgency = path.join(fixtureDir, "fork-test.agency");
const forkCompiled = path.join(fixtureDir, "fork-test.ts");

beforeAll(() => {
  compile({}, agentAgency, agentCompiled, { ts: true });
  compile({}, guardAgency, guardCompiled, { ts: true });
  compile({}, forkAgency, forkCompiled, { ts: true });
});

const mocks: LLMMock[] = [
  { toolCall: { name: "search", args: { query: "grant", breakHere: false } } },
  { return: "grant summary" },
  { toolCall: { name: "writeUp", args: { notes: "grant summary" } } },
  { return: "final report" },
];

async function session() {
  const mod = await freshImport(agentCompiled);
  return await DebuggerTestSession.create({ mod, args: ["research"] });
}

const pane = (s: DebuggerTestSession, name: string) => s.frame().findByKey(name)!.toPlainText();
const stats = (s: DebuggerTestSession) => s.frame().findByKey("stats")!.toPlainText();
const activity = (s: DebuggerTestSession) => s.ui.state.getActivityLog();

/** Focus the pane called `name` by pressing Tab until it is focused. */
async function focus(s: DebuggerTestSession, name: string) {
  for (let i = 0; i < 9; i++) {
    if (s.ui.focusedPaneName() === name) return;
    await s.press("tab");
  }
  throw new Error(`no pane ${name}`);
}

describe("the composer under the thread", () => {
  it("Enter opens it, Enter sends, the message shows as pending, and the model gets it", async () => {
    await withLLMMocks(mocks, async () => {
      const s = await session();
      await s.press("s"); // round 1: the thread has the task
      await focus(s, "threads");
      expect(stats(s)).toContain("enter: say something to the model");
      await s.press("enter");
      expect(pane(s, "threads")).toContain("> ");
      expect(stats(s)).toContain("enter: send");
      await s.type("stop"); // type() ends with Enter, which sends
      expect(activity(s)).toContainEqual("appended to thread 0 (2 messages)");
      expect(pane(s, "threads")).toContain("stop (pending)");
      expect(stats(s)).toContain("1 edit pending");
      // The pane's keys still work with the composer closed: step to the
      // next stop, whose checkpoint holds the message for real.
      await s.press("s");
      const messages = s.ui.state.getThreadMessages()!.messages;
      expect(messages.some((m) => m.role === "user" && m.content === "stop")).toBe(true);
      expect(pane(s, "threads")).not.toContain("(pending)");
    });
  });

  it("attached, Escape still closes the composer and keeps the draft", async () => {
    await withLLMMocks(mocks, async () => {
      const s = await session();
      await s.press("s");
      s.ui.attachedTo({ type: "hello", program: "agent.js", node: "main", pid: 4242 });
      await focus(s, "threads");
      await s.press("enter");
      for (const ch of "dra") await s.press(ch);
      await s.press("escape");
      expect(stats(s)).not.toContain("enter: send");
      expect(pane(s, "threads")).toContain("dra");
      expect(stats(s)).not.toContain("edit pending");
    });
  });

  it("Escape keeps the draft, and x drops the pending edits", async () => {
    await withLLMMocks(mocks, async () => {
      const s = await session();
      await s.press("s");
      await focus(s, "threads");
      await s.press("enter");
      for (const ch of "dra") await s.press(ch);
      await s.press("escape");
      expect(pane(s, "threads")).toContain("dra");
      await s.press("enter");
      expect(pane(s, "threads")).toContain("dra");
      await s.type("ft");
      expect(stats(s)).toContain("1 edit pending");
      await s.press("x");
      expect(stats(s)).not.toContain("edit pending");
      expect(activity(s)).toContainEqual("dropped 1 pending edits");
    });
  });
});

describe("a row's edit", () => {
  it("Enter on a local sets it, and the next stop shows the value", async () => {
    await withLLMMocks(mocks, async () => {
      const s = await session();
      await s.press("s", { times: 4 }); // inside search, url assigned
      await focus(s, "locals");
      expect(stats(s)).toContain("enter: set");
      await s.press("down", { times: 2 }); // query, breakHere, url
      await s.press("enter");
      await s.type('"other"');
      expect(activity(s)).toContainEqual('url = "other"');
      expect(pane(s, "locals")).toContain('url = "other"');
      await s.press("n");
      expect(pane(s, "locals")).toContain('url = "other"');
    });
  });

  it("a value that is not JSON is taken as text", async () => {
    await withLLMMocks(mocks, async () => {
      const s = await session();
      await s.press("s", { times: 4 });
      await focus(s, "locals");
      await s.press("down", { times: 2 });
      await s.press("enter");
      await s.type("{not json");
      expect(activity(s)).toContainEqual('url = "{not json"');
    });
  });

  it("a refused edit is logged with the reason and queues nothing", async () => {
    await withLLMMocks(mocks, async () => {
      const s = await session();
      await s.press("s", { times: 4 });
      // A `__` name is the compiler's, which the patch refuses.
      await s.press(":");
      await s.type("set __step = 1");
      expect(activity(s).some((line) => /^refused: .*control field/.test(line))).toBe(true);
      expect(stats(s)).not.toContain("edit pending");
    });
  });

  it("the cursor stays in view: a row below the pane scrolls it", async () => {
    await withLLMMocks(mocks, async () => {
      const mod = await freshImport(agentCompiled);
      const s = await DebuggerTestSession.create({ mod, args: ["research"], height: 14 });
      await s.press("s", { times: 4 }); // inside search: query, breakHere, url
      await focus(s, "locals");
      await s.press("down", { times: 2 });
      expect(pane(s, "locals")).toContain("url");
      expect(stats(s)).toContain("enter: set");
    });
  });
});

describe("the other rows", () => {
  it("disarming a guard before it trips lets the program run past the trip", async () => {
    await withLLMMocks([{ return: "one" }, { return: "two" }], async () => {
      const mod = await freshImport(guardCompiled);
      const s = await DebuggerTestSession.create({ mod });
      // Into the guard block, where the guards pane lists research.
      const guards = () => s.frame().findByKey("guards")?.toPlainText() ?? "";
      for (let i = 0; i < 5 && !guards().includes("research"); i++) await s.press("s");
      await focus(s, "guards");
      expect(stats(s)).toContain("e: disarm");
      expect(stats(s)).toContain("b: budget");
      await s.press("e");
      expect(activity(s)).toContainEqual("disarmed");
      expect(pane(s, "guards")).toContain("(disarmed)");
      await s.press("c");
      expect(await s.quit()).toMatchObject({ success: true, value: "onetwo" });
    });
  });

  it("Ctrl+K opens the palette; typing narrows it and Enter runs the edit on its row", async () => {
    await withLLMMocks([{ return: "one" }, { return: "two" }], async () => {
      const mod = await freshImport(guardCompiled);
      const s = await DebuggerTestSession.create({ mod });
      const guards = () => s.frame().findByKey("guards")?.toPlainText() ?? "";
      for (let i = 0; i < 5 && !guards().includes("research"); i++) await s.press("s");
      await s.press("k", { ctrl: true });
      const palette = () => s.frame().toPlainText();
      expect(palette()).toContain("edits (type to filter");
      expect(palette()).toContain("set label in _guard");
      expect(palette()).toContain("  disarm the guard research");
      for (const ch of "disarm") await s.press(ch);
      expect(palette()).toContain("> disarm the guard research");
      expect(palette()).not.toContain("set label in _guard");
      await s.press("enter");
      expect(activity(s)).toContainEqual("disarmed");
      expect(s.ui.focusedPaneName()).toBe("guards");
      expect(pane(s, "guards")).toContain("(disarmed)");
    });
  });

  it("removing a tool from the loop shows from the next round", async () => {
    await withLLMMocks(mocks, async () => {
      const s = await session();
      await s.press("s"); // round 1
      await focus(s, "callStack");
      // main, llm(), then the loop's tools: search is the first.
      await s.press("down", { times: 2 });
      expect(stats(s)).toContain("e: remove");
      await s.press("e");
      expect(activity(s)).toContainEqual("removed search from the next round");
      expect(pane(s, "callStack")).toContain("(remove");
      await s.press("s");
      expect(pane(s, "guards")).toContain("removed: search");
    });
  });

  it("a fork branch given a result at its breakpoint finishes with it", async () => {
    const mod = await freshImport(forkCompiled);
    const s = await DebuggerTestSession.create({ mod: { ...mod, main: mod.withBreakpoint } });
    await s.press("c"); // the breakpoint in the first branch
    await focus(s, "branches");
    await s.press("down"); // the second branch
    expect(stats(s)).toContain("e: result");
    await s.press("e");
    await s.type("100");
    expect(activity(s).some((line) => line.endsWith("finished with 100"))).toBe(true);
    await s.press("c");
    // 2 + 100 + 6: the second branch's doubled 2 is replaced.
    expect(await s.quit()).toBe(108);
  });
});
