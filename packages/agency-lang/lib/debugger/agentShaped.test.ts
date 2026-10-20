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

/** A session on `node` of the agent fixture. The model's replies come
 *  from the `withLLMMocks` the caller is inside. */
async function agentSession(node = "main", args: unknown[] = ["research"]) {
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
      const session = await agentSession();
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
      const session = await agentSession();
      expect(lineWithMarker(session)).toContain("llm(task");
      await session.press("s");
      expect(lineWithMarker(session)).toContain("const url");
      expect(localsText(session)).toContain('query = "grant"');
      expect(session.ui.state.getActivityLog()).toContainEqual(
        'Tool call: search(query: "grant", breakHere: false)',
      );
    });
  });

  it("step in from the llm() line lands on the tool's first statement too", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
      await session.press("i");
      expect(lineWithMarker(session)).toContain("const url");
      await session.press("n");
      expect(lineWithMarker(session)).toContain("if (breakHere)");
    });
  });

  it("next from the llm() line runs the whole call", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
      await session.press("n");
      expect(lineWithMarker(session)).toContain("return answer");
      expect(modelRequests(session)).toBe(4);
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("inside the tool, next walks its statements and step out leaves the llm() call", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
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
      const session = await agentSession();
      await session.press("c");
      expect(lineWithMarker(session)).toContain('debugger("in search")');
      expect(localsText(session)).toContain('url = "https://example.test/grant"');
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("print reads the tool's variables and set is refused", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
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
        "set inside a tool call, a fork, or a parallel block is not supported yet",
      );
    });
  });

  it("step back from a breakpoint reached under continue stays in the tool", async () => {
    // `continue` runs through the llm() line without stopping. Its frame
    // keeps the step's flag while the call runs, so the rolling checkpoint
    // inside the tool carries it and the rewind replays through the
    // llm() line instead of stopping there.
    await withLLMMocks(agentMocks({ breakInSearch: true }), async () => {
      const session = await agentSession();
      await session.press("c");
      expect(lineWithMarker(session)).toContain('debugger("in search")');
      const requestsBefore = modelRequests(session);
      await session.press("up");
      expect(lineWithMarker(session)).toContain("if (breakHere)");
      expect(modelRequests(session)).toBe(requestsBefore);
      // The breakpoint is met again on the way out.
      await session.press("c");
      expect(lineWithMarker(session)).toContain('debugger("in search")');
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("step back inside the tool lands on its previous statement without a model request", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
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
      const session = await agentSession("insideHandler", []);
      await session.press("c");
      expect(session.ui.state.getActivityLog()).toContainEqual(
        'Program finished. Return value: "handled"',
      );
      expect(await session.quit()).toBe("handled");
    });
  });

  const twoToolMocks: LLMMock[] = [
    {
      toolCalls: [
        { name: "search", args: { query: "grant", breakHere: false } },
        { name: "writeUp", args: { notes: "notes" } },
      ],
    },
    { return: "grant summary" },
    { return: FINAL },
  ];

  it("two tools in one round: one stop is shown, both tools complete", async () => {
    await withLLMMocks(twoToolMocks, async () => {
      const session = await agentSession();
      await session.press("s");
      expect(lineWithMarker(session)).toContain("const url");
      await session.press("s", { times: 20 });
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("step back stays in the stopped tool, and a rewind point taken after a sibling finished keeps its reply", async () => {
    await withLLMMocks(twoToolMocks, async () => {
      const session = await agentSession();
      // writeUp has three statements and finishes while search is still
      // stepping. One more step after that, so the current step's rolling
      // checkpoint was taken after writeUp's reply reached the thread.
      await session.press("s");
      for (let i = 0; i < 10 && !toolDone(session, "writeUp"); i++) {
        await session.press("s");
      }
      expect(toolDone(session, "writeUp")).toBe(true);
      await session.press("s");
      expect(searchLines.some((line) => lineWithMarker(session).includes(line))).toBe(true);
      // The rolling checkpoint of the current step is stamped from the
      // root, and its runPrompt frame holds the thread the loop would
      // resume with. writeUp's reply is in it.
      const latest = session.driver.debuggerState.getCheckpoints().sort((a, b) => b.id - a.id)[0];
      expect(latest.scopeName).toBe("search");
      const promptFrame = latest.stack.stack[1];
      expect(JSON.stringify(promptFrame.locals.messagesJSON)).toContain("# Report");
      // step back lands on search's previous statement, not on writeUp's.
      await session.press("up");
      expect(searchLines.some((line) => lineWithMarker(session).includes(line))).toBe(true);
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });
});

const searchLines = [
  "const url",
  "if (breakHere)",
  "let summary",
  "thread {",
  "summary = llm",
  "return summary",
];

function toolDone(session: DebuggerTestSession, name: string): boolean {
  return session.ui.state.getActivityLog().some((line) => line.startsWith(`Tool done: ${name}`));
}

describe("stopping inside a fork branch", () => {
  async function forkSession(node = "main") {
    const mod = await freshImport(forkCompiled);
    return await DebuggerTestSession.create({ mod: { ...mod, main: mod[node] } });
  }

  it("steps into a branch with the branch's locals", async () => {
    const session = await forkSession();
    const seen: string[] = [];
    for (let i = 0; i < 12 && !session.isFinished; i++) {
      await session.press("s");
      seen.push(localsText(session));
    }
    expect(seen.some((text) => text.includes("item = 1"))).toBe(true);
    expect(await session.quit()).toBe(12);
  });

  it("next walks a branch's statements as it does a loop body, and step out runs to the node's end", async () => {
    const session = await forkSession();
    await session.press("n");
    expect(lineWithMarker(session)).toContain("fork(items)");
    // The fork statement has a second step on its own line before the
    // branches start.
    await session.press("n", { times: 2 });
    expect(lineWithMarker(session)).toContain("const twice");
    expect(localsText(session)).toContain("item = 1");
    await session.press("n");
    expect(lineWithMarker(session)).toContain("return twice");
    expect(localsText(session)).toContain("twice = 2");
    // A branch is at its node's depth, so step out leaves the node.
    await session.press("o");
    expect(session.ui.state.getActivityLog()).toContainEqual("Program finished. Return value: 12");
    expect(await session.quit()).toBe(12);
  });

  it("a debugger() inside a branch stops under continue, with the branch's locals", async () => {
    const session = await forkSession("withBreakpoint");
    await session.press("c");
    expect(lineWithMarker(session)).toContain('debugger("in branch")');
    expect(localsText(session)).toContain("twice = 2");
    await session.press(":");
    await session.type("set twice = 5");
    expect(session.ui.state.getActivityLog()).toContainEqual(
      "set inside a tool call, a fork, or a parallel block is not supported yet",
    );
    await session.press("c");
    expect(await session.quit()).toBe(12);
  });

  it("a global changed in a branch shows the branch's value, and keeps it through a rewind", async () => {
    const session = await forkSession("withGlobal");
    await session.press("n", { times: 3 });
    expect(lineWithMarker(session)).toContain("counter = counter + item");
    await session.press("n");
    expect(lineWithMarker(session)).toContain("const twice");
    // The branch runs on its own copy of the globals; print reads that copy.
    await session.press("p");
    await session.type("counter");
    expect(session.ui.state.getActivityLog()).toContainEqual("counter = 1");
    // The rolling checkpoint of `const twice` was taken after the
    // assignment ran, so the branch's copy in it must already hold 1: the
    // replay skips the assignment.
    await session.press("n");
    expect(lineWithMarker(session)).toContain("return twice");
    await session.press("up");
    expect(lineWithMarker(session)).toContain("const twice");
    await session.press("p");
    await session.type("counter");
    expect(session.ui.state.getActivityLog().filter((line) => line === "counter = 1")).toHaveLength(
      2,
    );
    await session.press("c");
    // The branch's change is its own: the node returns the root's value.
    expect(await session.quit()).toBe(0);
  });
});
