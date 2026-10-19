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

const SEARCH_STOP = 'search(query: "grant", breakHere: false)';

function activity(session: DebuggerTestSession): string[] {
  return session.ui.state.getActivityLog();
}

describe("the tool loop's own stops", () => {
  // Depth: the llm() statement is at 0, the loop's stops at 1 (the
  // runPrompt frame), a tool's statements at 2.
  it("step from the llm() line stops at round 1, then before the tool, then inside it", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      expect(lineWithMarker(session)).toContain("llm(task");
      await session.press("s");
      expect(activity(session)).toContainEqual("Stopped before round 1");
      // A loop stop has no source line: the llm() line stays highlighted
      // and the locals are the caller's.
      expect(lineWithMarker(session)).toContain("llm(task");
      expect(localsText(session)).toContain('task = "research"');
      await session.press("s");
      expect(activity(session)).toContainEqual(`Stopped before ${SEARCH_STOP}`);
      expect(lineWithMarker(session)).toContain("llm(task");
      await session.press("s");
      expect(lineWithMarker(session)).toContain("const url");
      expect(localsText(session)).toContain('query = "grant"');
    });
  });

  it("next from the llm() line runs the whole call", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("n");
      expect(lineWithMarker(session)).toContain("return answer");
      expect(modelRequests(session)).toBe(4);
      expect(activity(session)).not.toContainEqual("Stopped before round 1");
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("step in from the llm() line stops at round 1, and from the tool stop enters the tool", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("i");
      expect(activity(session)).toContainEqual("Stopped before round 1");
      await session.press("i");
      expect(activity(session)).toContainEqual(`Stopped before ${SEARCH_STOP}`);
      await session.press("i");
      expect(lineWithMarker(session)).toContain("const url");
    });
  });

  it("next at a tool stop runs the tool and stops before the next request", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("s"); // round 1
      await session.press("s"); // before search
      await session.press("n");
      expect(activity(session)).toContainEqual("Stopped before round 2");
      expect(activity(session)).toContainEqual(`Tool call: ${SEARCH_STOP}`);
      await session.press("n");
      expect(activity(session)).toContainEqual('Stopped before writeUp(notes: "grant summary")');
      await session.press("n");
      expect(activity(session)).toContainEqual("Stopped before round 3");
      await session.press("n");
      expect(lineWithMarker(session)).toContain("return answer");
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("step out at a loop stop lands on the statement after llm()", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("s"); // round 1
      await session.press("o");
      expect(lineWithMarker(session)).toContain("return answer");
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("inside the tool, next walks its statements and step out lands on the loop's next stop", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("s"); // round 1
      await session.press("s"); // before search
      await session.press("s"); // const url
      await session.press("n"); // if (breakHere)
      await session.press("n"); // let summary
      expect(lineWithMarker(session)).toContain("let summary");
      expect(localsText(session)).toContain('url = "https://example.test/grant"');
      await session.press("o");
      expect(activity(session)).toContainEqual("Stopped before round 2");
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("a round with two tool calls stops before each call, then before the next request", async () => {
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
      await session.press("s"); // round 1
      await session.press("n");
      expect(activity(session)).toContainEqual(`Stopped before ${SEARCH_STOP}`);
      await session.press("n");
      expect(activity(session)).toContainEqual('Stopped before writeUp(notes: "notes")');
      await session.press("n");
      expect(activity(session)).toContainEqual("Stopped before round 2");
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  // The subagent inside `search` runs its own loop, so "round 1" is seen
  // twice on purpose; the tool stops are unique.
  it("a resumed step does not stop twice", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("s", { times: 12 });
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
      const stops = activity(session).filter((line) => line.startsWith("Stopped before "));
      expect(stops.filter((line) => line === `Stopped before ${SEARCH_STOP}`)).toHaveLength(1);
      expect(stops.filter((line) => line.includes("writeUp"))).toHaveLength(1);
      expect(stops.filter((line) => line === "Stopped before round 1")).toHaveLength(2);
    });
  });
});

describe("stopping inside a tool call", () => {
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
      await session.press("s"); // round 1
      await session.press("s"); // before search
      await session.press("s"); // const url
      await session.press("n"); // if (breakHere)
      await session.press("p");
      await session.type("url");
      expect(activity(session)).toContainEqual('url = "https://example.test/grant"');
      await session.press(":");
      await session.type('set url = "other"');
      expect(activity(session)).toContainEqual("set inside a tool call is not supported yet");
    });
  });

  it("step back inside the tool lands on its previous statement without a model request", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession(agentMocks());
      await session.press("s"); // round 1
      await session.press("s"); // before search
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
      expect(activity(session)).toContainEqual('Program finished. Return value: "handled"');
      expect(await session.quit()).toBe("handled");
    });
  });

  it("two tools in one round stepped into: one stop is shown, both tools complete", async () => {
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
      await session.press("s"); // round 1
      await session.press("s"); // before search
      await session.press("s"); // before writeUp
      await session.press("s"); // both bodies start; one stop is shown
      expect(lineWithMarker(session)).toMatch(/const url|const heading/);
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
