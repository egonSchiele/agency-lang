import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import {
  freshImport,
  fixtureDir,
  withLLMMocks,
  recordingResumes,
  type RecordedResume,
} from "./testHelpers.js";
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
async function agentSession(
  node = "main",
  args: unknown[] = ["research"],
  resumes: RecordedResume[] = [],
) {
  const mod = await freshImport(agentCompiled);
  const recording = recordingResumes({ ...mod, main: mod[node] }, resumes);
  return await DebuggerTestSession.create({ mod: recording, args });
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

const SEARCH_STOP = 'search(query: "grant", breakHere: false)';

function activity(session: DebuggerTestSession): string[] {
  return session.ui.state.getActivityLog();
}

describe("the tool loop's own stops", () => {
  // Depth: the llm() statement is at 0, the loop's stops at 1, a tool's
  // statements at 2.
  it("step from the llm() line stops at round 1, then before the tool, then inside it", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
      expect(lineWithMarker(session)).toContain("llm(task");
      await session.press("s");
      expect(activity(session)).toContainEqual("Stopped before round 1");
      // A loop stop has no source line of its own: the llm() line is
      // highlighted and the locals are the caller's.
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
      const session = await agentSession();
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
      const session = await agentSession();
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
      const session = await agentSession();
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
      const session = await agentSession();
      await session.press("s"); // round 1
      await session.press("o");
      expect(lineWithMarker(session)).toContain("return answer");
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("print at a loop stop reads the caller's variables, and set is refused", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
      await session.press("s"); // round 1
      await session.press("p");
      await session.type("task");
      expect(activity(session)).toContainEqual('task = "research"');
      await session.press(":");
      await session.type('set task = "other"');
      expect(activity(session)).toContainEqual(
        "set before a model request or a tool call is not supported yet",
      );
    });
  });

  it("a subagent's round stop shows the tool's frame and its llm() line", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
      await session.press("s"); // round 1
      await session.press("s"); // before search
      await session.press("s"); // const url
      await session.press("n"); // if (breakHere)
      await session.press("n"); // let summary
      await session.press("n"); // thread {
      await session.press("n"); // summary = llm(...)
      expect(lineWithMarker(session)).toContain("summary = llm");
      await session.press("s");
      expect(activity(session).filter((line) => line === "Stopped before round 1")).toHaveLength(2);
      expect(lineWithMarker(session)).toContain("summary = llm");
      expect(localsText(session)).toContain('url = "https://example.test/grant"');
      expect(localsText(session)).not.toContain("task =");
    });
  });

  it("a round with two tool calls stops before each call, then before the next request", async () => {
    await withLLMMocks(twoToolMocks, async () => {
      const session = await agentSession();
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
      const session = await agentSession();
      await session.press("s", { times: 12 });
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
      const stops = activity(session).filter((line) => line.startsWith("Stopped before "));
      expect(stops.filter((line) => line === `Stopped before ${SEARCH_STOP}`)).toHaveLength(1);
      expect(stops.filter((line) => line.includes("writeUp"))).toHaveLength(1);
      expect(stops.filter((line) => line === "Stopped before round 1")).toHaveLength(2);
    });
  });

  it("the rewind list marks a checkpoint taken before a model request", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
      await session.press("s"); // round 1
      await session.press("s"); // before search
      const checkpoints = session.driver.debuggerState.getCheckpoints();
      expect(checkpoints.map((cp) => cp.loopStop)).toEqual([undefined, "round", "tool"]);
    });
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

describe("stopping inside a tool call", () => {
  it("inside the tool, next walks its statements and step out lands on the loop's next stop", async () => {
    await withLLMMocks(agentMocks(), async () => {
      const session = await agentSession();
      await session.press("s"); // round 1
      await session.press("s"); // before search
      await session.press("s"); // const url
      await session.press("n"); // if (breakHere)
      await session.press("n"); // let summary
      expect(lineWithMarker(session)).toContain("let summary");
      expect(localsText(session)).toContain('url = "https://example.test/grant"');
      await session.press("o");
      expect(activity(session)).toContainEqual("Stopped before round 2");
      // The source pane moves back to the llm() line the loop belongs to.
      expect(lineWithMarker(session)).toContain("llm(task");
      expect(localsText(session)).toContain('task = "research"');
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
      await session.press("s"); // round 1
      await session.press("s"); // before search
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
      const session = await agentSession("insideHandler", []);
      await session.press("c");
      expect(session.ui.state.getActivityLog()).toContainEqual(
        'Program finished. Return value: "handled"',
      );
      expect(await session.quit()).toBe("handled");
    });
  });

  it("two tools in one round stepped into: one stop is shown, both tools complete", async () => {
    await withLLMMocks(twoToolMocks, async () => {
      const session = await agentSession();
      await session.press("s"); // round 1
      await session.press("s"); // before search
      await session.press("s"); // before writeUp
      await session.press("s"); // both bodies start; one stop is shown
      expect(lineWithMarker(session)).toMatch(/const url|const heading/);
      await session.press("s", { times: 20 });
      expect(await session.quit()).toBe(FINAL);
    });
  });

  it("print at one of two stops keeps the batch, and continue moves both", async () => {
    await withLLMMocks(twoToolMocks, async () => {
      const resumes: RecordedResume[] = [];
      const session = await agentSession("main", ["research"], resumes);
      await session.press("s", { times: 4 }); // round 1, two tool stops, both bodies
      expect(lineWithMarker(session)).toMatch(/const url|const heading/);
      await session.press("p");
      await session.type("query");
      await session.press("c");
      expect(await session.quit()).toBe(FINAL);
      const last = resumes.at(-1)!;
      expect(last.interrupts).toBe(2);
      expect(last.responses).toEqual([{ type: "approve" }, { type: "approve" }]);
    });
  });

  it("a stop and a real interrupt in one batch: the interrupt is asked about, the stop moves with it", async () => {
    const mocks: LLMMock[] = [
      {
        toolCalls: [
          { name: "search", args: { query: "grant", breakHere: true } },
          { name: "confirm", args: { note: "send" } },
        ],
      },
      { return: "grant summary" },
      { return: FINAL },
    ];
    await withLLMMocks(mocks, async () => {
      const resumes: RecordedResume[] = [];
      const session = await agentSession("main", ["research"], resumes);
      await session.press("c");
      expect(activity(session)).toContainEqual("Interrupt: confirm send?");
      expect(activity(session).filter((line) => line.startsWith("Interrupt"))).toHaveLength(1);
      // An answer the driver does not understand is asked for again.
      await session.type("maybe");
      expect(activity(session)).toContainEqual(
        'Unknown response: "maybe". Try: approve, reject, resolve <value>',
      );
      await session.type("approve");
      expect(await session.quit()).toBe(FINAL);
      const batch = resumes.find((resume) => resume.interrupts === 2)!;
      expect(batch.responses).toEqual([{ type: "approve" }, { type: "approve" }]);
      expect(activity(session).some((line) => line.startsWith("Tool done: confirm"))).toBe(true);
    });
  });

  it("step back stays in the stopped tool, and a rewind point taken after a sibling finished keeps its reply", async () => {
    await withLLMMocks(twoToolMocks, async () => {
      const session = await agentSession();
      // writeUp has three statements and finishes while search is still
      // stepping. One more step after that, so the current step's rolling
      // checkpoint was taken after writeUp's reply reached the thread.
      await session.press("s", { times: 4 });
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
