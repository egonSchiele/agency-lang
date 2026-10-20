import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as smoltalk from "smoltalk";
import * as fs from "fs";
import * as path from "path";
import type { DebuggerCommand } from "./types.js";
import { compile } from "@/compiler/defaultSession.js";
import { hasInterrupts } from "@/runtime/interrupts.js";
import { TestDebuggerIO, freshImport, makeDriver, fixtureDir } from "./testHelpers.js";
import { DebuggerTestSession } from "./testSession.js";

// Queue of canned responses for the mock runPrompt
let mockResponses: string[] = [];

vi.mock("agency-lang/runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("../runtime/index.js")>();
  return {
    ...original,
    // Minimal mock: pushes user + assistant messages onto the thread and returns
    // the response. Skips hooks (onLLMCallStart/End), token stats, and audit logs.
    runPrompt: async (_run: any, args: any) => {
      const response = mockResponses.shift() ?? "(no mock response)";

      // Push user + assistant messages onto the thread in-place,
      // just like the real runPrompt does. args.messages is the live
      // MessageThread reference from the ThreadStore.
      if (args.messages?.push) {
        args.messages.push(smoltalk.userMessage(args.prompt));
        args.messages.push(smoltalk.assistantMessage(response));
      }

      if (args.responseFormat) {
        try {
          return JSON.parse(response);
        } catch {
          return response;
        }
      }
      return response;
    },
  };
});

const threadTestAgency = path.join(fixtureDir, "thread-test.agency");
const threadTestCompiled = path.join(fixtureDir, "thread-test.ts");

describe("Debugger threads panel", () => {
  beforeAll(() => {
    compile({}, threadTestAgency, threadTestCompiled, { ts: true });
  });

  afterAll(() => {
    try {
      fs.unlinkSync(threadTestCompiled);
    } catch {}
  });

  it("shows thread messages after each LLM call", async () => {
    mockResponses = ["Paris", '{"response":{"capital":"Paris","pop":2161000}}'];
    const mod = await freshImport(threadTestCompiled);
    // Enough steps to walk through the entire program
    const commands: DebuggerCommand[] = Array(20).fill({ type: "step" });
    const testUI = new TestDebuggerIO(commands);

    const driver = makeDriver(mod, testUI);
    const callbacks = driver.getCallbacks();
    const initialResult = await mod.main({ callbacks });
    expect(hasInterrupts(initialResult?.data)).toBe(true);

    await driver.run(initialResult, { interceptConsole: false });

    // Find the first checkpoint where threads have 2 messages (after first llm call)
    const twoMessages = testUI.renderCalls.find((cp) => {
      const thread = cp.getThreadMessages();
      return thread !== null && thread.messages.length === 2;
    });
    expect(twoMessages).toBeDefined();
    const firstThread = twoMessages!.getThreadMessages()!;
    expect(firstThread.messages[0].role).toBe("user");
    expect(firstThread.messages[0].content).toContain("capital of France");
    expect(firstThread.messages[1].role).toBe("assistant");
    expect(firstThread.messages[1].content).toBe("Paris");

    // Find the first checkpoint where threads have 4 messages (after second llm call)
    const fourMessages = testUI.renderCalls.find((cp) => {
      const thread = cp.getThreadMessages();
      return thread !== null && thread.messages.length === 4;
    });
    expect(fourMessages).toBeDefined();
    const secondThread = fourMessages!.getThreadMessages()!;
    expect(secondThread.messages[0].role).toBe("user");
    expect(secondThread.messages[1].role).toBe("assistant");
    expect(secondThread.messages[2].role).toBe("user");
    expect(secondThread.messages[2].content).toContain("population");
    expect(secondThread.messages[3].role).toBe("assistant");
  });

  it("a picked thread stays shown while it is still listed", async () => {
    mockResponses = ["1", "2", "3"];
    const mod = await freshImport(threadTestCompiled);
    const session = await DebuggerTestSession.create({ mod: { ...mod, main: mod.withSubthread } });
    const pane = () => session.frame().findByKey("threads")?.toPlainText() ?? "";
    // To `third = llm("three")`: the subthread is active, and it holds
    // the thread's exchange it started from plus its own.
    for (let i = 0; i < 20 && !pane().includes("[user] two"); i++) {
      await session.press("s");
    }
    expect(pane()).toContain("[3/3]");
    await session.press("["); // the thread's own, with the first exchange only
    expect(pane()).toContain("[2/3]");
    expect(pane()).toContain("[user] one");
    expect(pane()).not.toContain("[user] two");
    await session.press("s"); // the third call ran on the subthread
    expect(pane()).toContain("[2/3]");
    expect(pane()).not.toContain("[user] three");
    await session.press("]");
    expect(pane()).toContain("[3/3]");
    expect(pane()).toContain("[user] three");
    await session.quit();
  });
});
