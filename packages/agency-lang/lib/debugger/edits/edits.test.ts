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

beforeAll(() => {
  compile({}, agentAgency, agentCompiled, { ts: true });
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
