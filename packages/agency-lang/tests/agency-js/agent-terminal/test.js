// The terminal's session (lib/stdlib/agentTerminalSession.ts) driving the
// agent's real session program, with a scripted model and a stand-in for
// the shell run: what it asks, the policy it gives, and the lines it shows.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCall } from "smoltalk";

process.env.AGENCY_AGENT_HOME = mkdtempSync(path.join(os.tmpdir(), "agent-terminal-home-"));
process.env.ANTHROPIC_API_KEY = "test-key";
const project = mkdtempSync(path.join(os.tmpdir(), "agent-terminal-project-"));
const dir = path.join(process.env.AGENCY_AGENT_HOME, "sessions", "project");
mkdirSync(dir, { recursive: true });

const program = await import("../../../dist/lib/agents/agency-agent/program.js");
const { approve, __setLLMClient } = program;
const { terminalSession } = await import("../../../dist/lib/stdlib/agentTerminalSession.js");
const { takeHold, thisProcessId, messageAnswer } =
  await import("../../../dist/lib/stdlib/agentDriver/index.js");
const { sessionJobs, stopSessionJob } =
  await import("../../../dist/lib/stdlib/agentDriver/jobControl.js");
const { AgencyCancelledError } = await import("../../../dist/lib/runtime/errors.js");
const { _savedTranscript } = await import("../../../dist/lib/stdlib/agentTerminalDriver.js");
const { currentHost } = await import("../../../dist/lib/runtime/currentHost.js");
const { listJobRecords } = await import("../../../dist/lib/runtime/jobs/detachedJobs.js");
const { _setManySessions } = await import("../../../dist/lib/stdlib/agentProcess.js");
_setManySessions(true);

const host = currentHost();
const HOLDER = { frontEnd: "terminal", pid: process.pid, processId: thisProcessId() };
const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const cost = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
// Every message the model was sent, for the cancel note.
const userTexts = [];
let modelCalls = 0;

function lastUserText(config) {
  const users = config.messages.filter((message) => message.role === "user");
  if (users.length === 0) return "";
  const content = users[users.length - 1].content;
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

function reply(output, toolCalls = []) {
  return { success: true, value: { output, toolCalls, model: "test", usage, cost } };
}

function toolRan(config) {
  return config.messages.some((message) => message.role === "tool");
}

function editCall(file) {
  return new ToolCall(`call-${file}`, "edit", {
    filename: file,
    edits: [{ oldText: "old line", newText: "new line", replaceAll: false }],
    dir: project,
  });
}

const jobCall = new ToolCall("call-job", "startJob", { command: "sleep 30", maxMinutes: 1 });

__setLLMClient({
  async text(config) {
    modelCalls += 1;
    const said = lastUserText(config);
    userTexts.push(said);
    // A call with no tools, such as the one that writes the title, quotes
    // the conversation. It gets a plain reply.
    if ((config.tools ?? []).length === 0) return reply("a title");
    if (said.includes("edit three files")) {
      return toolRan(config)
        ? reply("edited all three")
        : reply(null, ["a.txt", "b.txt", "c.txt"].map(editCall));
    }
    if (said.includes("edit one file")) {
      return toolRan(config) ? reply("edited") : reply(null, [editCall("a.txt")]);
    }
    if (said.includes("start a job")) {
      if (!toolRan(config)) return reply(null, [jobCall]);
      // Slow enough for the test to cancel the turn after the job started.
      if (said.includes("slowly")) await new Promise((resolve) => setTimeout(resolve, 3000));
      return reply("the job is running");
    }
    return reply("stub reply");
  },
  async *textStream(config) {
    const response = await this.text(config);
    yield { type: "done", result: response.value };
  },
  async embed() {
    throw new Error("Unexpected embedding request");
  },
});

function writeFiles() {
  for (const file of ["a.txt", "b.txt", "c.txt"]) {
    writeFileSync(path.join(project, file), "first\nold line\nlast\n");
  }
}

function startData(id) {
  return {
    brain: "minimal",
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
  };
}

/** A stand-in for the shell run. `answer` answers each question asked. */
function standIn({ policy = {}, answer = () => approve() } = {}) {
  const shown = [];
  const state = { policy, asked: 0 };
  const shell = {
    ask: async (interrupt) => {
      state.asked += 1;
      return answer(interrupt, state);
    },
    policy: async () => state.policy,
    show: async (line) => void shown.push(line),
  };
  return { shell, shown, state };
}

function agentFor(start) {
  return {
    main: (opts) => program.main(start, opts),
    respondToInterrupts: program.respondToInterrupts,
  };
}

async function opened(id, standInShell, brain = "minimal") {
  const start = { ...startData(id), brain };
  const session = terminalSession({
    agent: agentFor(start),
    dir,
    home: process.env.AGENCY_AGENT_HOME,
    holder: HOLDER,
    host,
  });
  const problem = await session.start(standInShell.shell);
  if (problem !== "") throw new Error(`could not start: ${problem}`);
  return session;
}

function resumedSession(id) {
  return terminalSession({
    agent: agentFor(null),
    dir,
    home: process.env.AGENCY_AGENT_HOME,
    holder: HOLDER,
    host,
  });
}

const textsOf = (shown, kind) =>
  shown.filter((line) => line.kind === kind).map((line) => line.text);
const result = {};

// A line gets its reply, and the session's files exist.
{
  const s = standIn();
  const session = await opened("s-line", s);
  await session.send(messageAnswer("hello"), s.shell);
  result.line = {
    replies: textsOf(s.shown, "reply"),
    files: ["s-line.json", "s-line.meta.json"].map((file) => existsSync(path.join(dir, file))),
  };
}

// Three edits in one pause. The first is answered "always": the rule it
// saves answers the other two, and each says so.
{
  writeFiles();
  const s = standIn({
    answer: (interrupt, state) => {
      state.policy = { "std::edit": [{ action: "approve" }] };
      return approve();
    },
  });
  const session = await opened("s-three", s);
  await session.send(messageAnswer("edit three files"), s.shell);
  result.threeEdits = {
    asked: s.state.asked,
    settledLines: textsOf(s.shown, "info").filter((text) => text.includes("by the rule just saved"))
      .length,
    replies: textsOf(s.shown, "reply"),
  };
}

// Esc at a prompt drops the turn, and the next message carries the note.
{
  writeFiles();
  const s = standIn({
    answer: () => {
      throw new AgencyCancelledError("cancelled at the prompt");
    },
  });
  const session = await opened("s-esc", s);
  await session.send(messageAnswer("edit one file"), s.shell);
  const waiting = session.pause() !== null;
  await session.send(messageAnswer("next message"), s.shell);
  const sent = userTexts.findLast((text) => text.includes("next message")) ?? "";
  result.escAtPrompt = {
    waiting,
    fileUnchanged: readFileSync(path.join(project, "a.txt"), "utf8").includes("old line"),
    nextCarriesNote: sent.includes("The user cancelled their previous request"),
  };
}

// Another front-end takes the session: the next line runs no leg, writes
// nothing, and says where the session went.
{
  const s = standIn();
  const session = await opened("s-moved", s);
  await session.send(messageAnswer("first"), s.shell);
  await takeHold({
    dir,
    id: "s-moved",
    holder: { frontEnd: "perry", pid: 1, processId: "another-process" },
  });
  const before = readFileSync(path.join(dir, "s-moved.json"), "utf8");
  const callsBefore = modelCalls;
  await session.send(messageAnswer("second"), s.shell);
  result.moved = {
    message: textsOf(s.shown, "warning").at(-1),
    ranNoLeg: modelCalls === callsBefore,
    wroteNothing: readFileSync(path.join(dir, "s-moved.json"), "utf8") === before,
  };
}

// /rename, then a resume shows the title and the conversation.
{
  const s = standIn();
  const session = await opened("s-rename", s);
  await session.send(messageAnswer("hello again"), s.shell);
  await session.send({ kind: "rename", title: "x" }, s.shell);
  const later = resumedSession("s-rename");
  const problem = await later.resume("s-rename", standIn().shell);
  const transcript = await _savedTranscript(dir, "s-rename");
  result.renameThenResume = {
    problem,
    title: later.pause()?.record?.title,
    transcript: transcript.map((message) => `${message.role}: ${message.content}`),
  };
}

// A job the session started is listed, stopped, and still listed after a
// resume.
{
  const s = standIn();
  const session = await opened("s-job", s, "coordinator");
  await session.send(messageAnswer("start a job"), s.shell);
  const listed = await sessionJobs(host, session.heldJobs());
  const id = listed[0]?.id ?? "";
  const stopped = await stopSessionJob({ host, jobs: session.heldJobs(), id });
  const later = resumedSession("s-job");
  await later.resume("s-job", standIn().shell);
  const afterResume = await sessionJobs(host, later.heldJobs());
  result.jobs = {
    listedRunning: listed.map((job) => job.state),
    stop: stopped.kind,
    afterResume: afterResume.map((job) => job.state),
    unknownId: (await stopSessionJob({ host, jobs: later.heldJobs(), id: "job-000000" })).kind,
  };
}

// A turn that starts a job and is then cancelled stops that job, and the
// session no longer holds it.
{
  const s = standIn();
  const session = await opened("s-job-cancel", s, "coordinator");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1500);
  await session.send(messageAnswer("start a job slowly"), s.shell, controller.signal);
  const records = (await listJobRecords(host))
    .filter((record) => record.label === "sleep 30")
    .map((record) => record.state);
  result.cancelledJob = {
    held: session.heldJobs().length,
    // One "stopped" from the job test above, and one from this cancel.
    states: records.sort(),
  };
}

writeFileSync("__result.json", JSON.stringify(result, null, 2));
process.exit(0);
