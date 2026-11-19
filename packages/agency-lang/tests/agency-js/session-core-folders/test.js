// Two sessions of the agent's session program in one process, each in its
// own folder, as an app's engine runs them. Each must get its own folder's
// `.claude/commands`, not the process's and not the other session's.
// No model is called: a test client answers every llm() call.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The agent home is read when the modules load, so it is set first.
process.env.AGENCY_AGENT_HOME = mkdtempSync(path.join(os.tmpdir(), "session-folders-home-"));
process.env.ANTHROPIC_API_KEY = "test-key";

/** A project folder whose `/hello` command says which folder it is. */
function projectWithHello(name) {
  const project = mkdtempSync(path.join(os.tmpdir(), `session-folders-${name}-`));
  mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
  writeFileSync(path.join(project, ".claude", "commands", "hello.md"), `hello from the ${name} folder`);
  return project;
}
const first = projectWithHello("first");
const second = projectWithHello("second");

const program = await import("../../../dist/lib/agents/agency-agent/program.js");
const { main, respondToInterrupts, approve, hasInterrupts, __setLLMClient } = program;

const PAUSE = "agent::sessionInput";
// No rule for the scans: they are the program's own reads, which it
// approves itself. A front-end must not be asked about them.
const policy = { [PAUSE]: [{ action: "propagate" }] };

function lastUserText(config) {
  const users = config.messages.filter((message) => message.role === "user");
  if (users.length === 0) return "";
  const content = users[users.length - 1].content;
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

// The reply is the message the model was sent, so a test reads what a
// slash command expanded to.
__setLLMClient({
  async text(config) {
    return {
      success: true,
      value: {
        output: lastUserText(config),
        toolCalls: [],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      },
    };
  },
  async *textStream(config) {
    const response = await this.text(config);
    yield { type: "done", result: response.value };
  },
  async embed() {
    throw new Error("Unexpected embedding request in the session folders test");
  },
});

let approvalsAsked = 0;

async function startIn(project, id) {
  const emitted = [];
  const callbacks = { onEmit: (event) => void emitted.push(event) };
  const started = await main(
    {
      brain: "simple",
      preset: "",
      models: { pin: "claude-sonnet-4-6", slots: {}, provider: "", local: null, effort: null },
      limits: { maxToolCallRounds: null, maxToolResultChars: null },
      session: {
        cwd: project,
        replyStyle: "",
        record: { id, cwd: project, brain: "", created: 1, lastActive: 1, turns: 0, title: "" },
        flags: null,
        budget: { maxCost: -1, maxTime: -1 },
      },
    },
    { callbacks, policy },
  );
  let pause = started.data;
  const countApprovals = () => {
    if (hasInterrupts(pause) && pause.some((interrupt) => interrupt.effect !== PAUSE)) {
      approvalsAsked += 1;
    }
  };
  countApprovals();
  return {
    async say(text) {
      const next = await respondToInterrupts(
        pause,
        [approve({ kind: "message", text, notes: [], target: "" })],
        { metadata: { callbacks }, invocation: { policy } },
      );
      pause = next.data;
      countApprovals();
      const replies = emitted.filter((event) => event.type === "session.reply");
      return replies[replies.length - 1]?.text ?? "";
    },
  };
}

// Both sessions are started before either takes a turn, as in an engine.
const one = await startIn(first, "s1");
const two = await startIn(second, "s2");
const firstReply = await one.say("/hello");
const secondReply = await two.say("/hello");
// And again, the other way round.
const firstAgain = await one.say("/hello");
// A command added while the process is up is there on the next message.
// An app's engine can stay up for days.
writeFileSync(path.join(first, ".claude", "commands", "later.md"), "added later to the first folder");
const addedLater = await one.say("/later");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      firstSessionSawItsOwnCommand: firstReply.includes("hello from the first folder"),
      secondSessionSawItsOwnCommand: secondReply.includes("hello from the second folder"),
      firstSessionStillSeesItsOwn: firstAgain.includes("hello from the first folder"),
      commandAddedLaterIsSeen: addedLater.includes("added later to the first folder"),
      approvalsAsked,
    },
    null,
    2,
  ),
);
process.exit(0);
