import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { freshImport, fixtureDir, withLLMMocks } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";
import type { LLMMock } from "../runtime/deterministicClient.js";

const agentAgency = path.join(fixtureDir, "agent-shaped.agency");
const agentCompiled = path.join(fixtureDir, "agent-shaped.ts");

const forkAgency = path.join(fixtureDir, "fork-test.agency");
const forkCompiled = path.join(fixtureDir, "fork-test.ts");

beforeAll(() => {
  compile({ debugger: true }, agentAgency, agentCompiled, { ts: true });
  compile({ debugger: true }, forkAgency, forkCompiled, { ts: true });
});

/** The replies in the order the program asks for them. The subagent's
 *  request comes while the outer call waits for `search`. */
function agentMocks(opts: { breakInSearch?: boolean } = {}): LLMMock[] {
  return [
    {
      toolCall: {
        name: "search",
        args: { query: "grant", breakHere: opts.breakInSearch === true },
      },
    },
    { return: "grant summary" },
    { toolCall: { name: "writeUp", args: { notes: "grant summary" } } },
    { return: "final report" },
  ];
}

const FINAL = "final report";

async function agentSession(mocks: LLMMock[], node = "main", args: unknown[] = ["research"]) {
  const mod = await freshImport(agentCompiled);
  return await DebuggerTestSession.create({ mod: { ...mod, main: mod[node] }, args });
}

function sourceText(session: DebuggerTestSession): string {
  return session.frame().findByKey("source")!.toPlainText();
}

function localsText(session: DebuggerTestSession): string {
  return session.frame().findByKey("locals")!.toPlainText();
}

function modelRequests(session: DebuggerTestSession): number {
  return session.ui.state.getActivityLog().filter((line) => line.startsWith("Calling LLM")).length;
}

describe("the harness", () => {
  it("runs the tool loop against scripted replies", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });
});

function lineWithMarker(session: DebuggerTestSession): string {
  const marked = sourceText(session)
    .split("\n")
    .find((line) => /│>\s+\d+\s+/.test(line));
  return marked ?? "";
}

describe("stopping inside a tool call", () => {
  it("step from the llm() line lands on the tool's first statement", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      expect(lineWithMarker(session)).toContain("llm(task");
      await session.press("s");
      expect(lineWithMarker(session)).toContain("const url");
      expect(localsText(session)).toContain('query = "grant"');
      expect(session.ui.state.getActivityLog()).toContainEqual(
        'Tool call: search(query: "grant", breakHere: false)',
      );
    });
  });

  it("next from the llm() line runs the whole call", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("n");
      expect(lineWithMarker(session)).toContain("return answer");
      expect(modelRequests(session)).toBe(4);
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("inside the tool, next walks its statements and step out leaves the llm() call", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("s"); // const url
      await session.press("n"); // if (breakHere)
      await session.press("n"); // let summary
      expect(lineWithMarker(session)).toContain("let summary");
      expect(localsText(session)).toContain('url = "https://example.test/grant"');
      await session.press("o");
      expect(lineWithMarker(session)).toContain("return answer");
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("a debugger() inside the tool stops under continue", async () => {
    const mocks = agentMocks({ breakInSearch: true });
    await withLLMMocks(mocks, async () => {
      const session = await agentSession(mocks);
      await session.press("c");
      expect(sourceText(session)).toContain("agent-shaped.agency");
      expect(localsText(session)).toContain('url = "https://example.test/grant"');
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("print reads the tool's variables and set is refused", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("s"); // const url
      await session.press("n"); // if (breakHere)
      await session.press("p");
      await session.type("url");
      expect(session.ui.state.getActivityLog()).toContainEqual(
        'url = "https://example.test/grant"',
      );
      await session.press(":");
      await session.type('set url = "other"');
      expect(session.ui.state.getActivityLog()).toContainEqual(
        "set inside a tool call is not supported yet",
      );
    });
  });

  it("step back inside the tool lands on its previous statement without a model request", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("s"); // const url
      await session.press("n"); // if (breakHere)
      await session.press("n"); // let summary
      const requestsBefore = modelRequests(session);
      await session.press("up");
      expect(lineWithMarker(session)).toContain("if (breakHere)");
      expect(localsText(session)).toContain('url = "https://example.test/grant"');
      expect(modelRequests(session)).toBe(requestsBefore);
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("a tool called from an llm() inside a handler body does not stop", async () => {
    const mocks: LLMMock[] = [
      { toolCall: { name: "search", args: { query: "grant", breakHere: true } } },
      { return: "grant summary" },
      { return: "done" },
    ];
    await withLLMMocks(mocks, async () => {
      const session = await agentSession(mocks, "insideHandler", []);
      await session.press("c");
      expect(session.ui.state.getActivityLog()).toContainEqual(
        'Program finished. Return value: "handled"',
      );
      expect(await session.quit()).toBe("handled");
    });
  });

  it("two tools in one round: one stop is shown, both tools complete", async () => {
    const mocks: LLMMock[] = [
      {
        toolCalls: [
          { name: "search", args: { query: "grant", breakHere: false } },
          { name: "writeUp", args: { notes: "notes" } },
        ],
      },
      { return: "grant summary" },
      { return: FINAL },
    ];
    await withLLMMocks(mocks, async () => {
      const session = await agentSession(mocks);
      await session.press("s");
      expect(lineWithMarker(session)).toContain("const url");
      await session.press("s", { times: 20 });
      expect(await session.quit()).toBe(FINAL);
    });
  });
});

describe("stopping inside a fork branch", () => {
  it("steps into a branch with the branch's locals", async () => {
    const mod = await freshImport(forkCompiled);
    const session = await DebuggerTestSession.create({ mod });
    const seen: string[] = [];
    for (let i = 0; i < 12 && !session.isFinished; i++) {
      await session.press("s");
      seen.push(localsText(session));
    }
    expect(seen.some((text) => text.includes("item = 1"))).toBe(true);
    expect(await session.quit()).toBe(12);
  });
});
