import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { RuntimeContext } from "./context.js";

// A resume in a process that is still running calls createExecutionContext
// again with the same run id. The kept log writer lets its first
// promptCompletion build on the last one before the interrupt, instead of
// logging every thread whole again.

function makeContext(logFile: string) {
  return new RuntimeContext({
    statelogConfig: {
      host: "",
      apiKey: "",
      projectId: "",
      debugMode: false,
      observability: true,
      logFile,
    },
    smoltalkDefaults: {},
    dirname: "/project",
  });
}

function tempLogFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "context-log-writer-")), "log.jsonl");
}

function readEvents(file: string): any[] {
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const one = { role: "user", content: "one" };
const two = { role: "user", content: "two" };

describe("the log writer an execution context gets", () => {
  it("two execution contexts for one run id share a log writer", async () => {
    const file = tempLogFile();
    const ctx = makeContext(file);
    const before = await ctx.createExecutionContext({ runId: "run-a" });
    await before.statelogClient.promptCompletion({
      messages: [one],
      completion: {},
      threadIdentity: "th",
    });
    const resumed = await ctx.createExecutionContext({ runId: "run-a" });
    await resumed.statelogClient.promptCompletion({
      messages: [one, two],
      completion: {},
      threadIdentity: "th",
    });
    const [first, second] = readEvents(file).filter(
      (event) => event.data.type === "promptCompletion",
    );
    expect(second.data.threadCall).toBe(2);
    expect(second.data.keptMessages).toBe(1);
    expect(second.data.logWriter).toBe(first.data.logWriter);
  });

  it("execution contexts for different run ids do not", async () => {
    const file = tempLogFile();
    const ctx = makeContext(file);
    for (const runId of ["run-a", "run-b"]) {
      const execCtx = await ctx.createExecutionContext({ runId });
      await execCtx.statelogClient.promptCompletion({
        messages: [one],
        completion: {},
        threadIdentity: "th",
      });
    }
    const [first, second] = readEvents(file).filter(
      (event) => event.data.type === "promptCompletion",
    );
    expect(first.data.threadCall).toBe(1);
    expect(second.data.threadCall).toBe(1);
    expect(second.data.logWriter).not.toBe(first.data.logWriter);
  });
});
