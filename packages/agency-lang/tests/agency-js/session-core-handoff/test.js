// One process starts a session and pauses in the middle of a turn, on an
// approval. A second process, which never ran `main`, approves it and
// finishes the turn. Both load the program through the package export,
// as two front-ends would.
//
// The first process also starts a session as `--policy minimal` would: it
// saves `minimal`'s rules as the session's policy file, and saves the
// session's first pause. The second reads that file and resumes the
// session through the session driver, with a saved policy that approves
// every read, and the session's own policy is the one that holds.
//
// This file is both processes: the second is started with RESUME set.
// (Only test.js is kept in git under tests/, so there is no second file.)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCall } from "smoltalk";
import { minimalAutoApprovePolicy } from "../../../dist/lib/runtime/builtinPolicies.js";

const PAUSE = "agent::sessionInput";
const policy = { [PAUSE]: [{ action: "propagate" }] };
// A front-end's saved policy that approves every read.
const APPROVES_EVERY_READ = { "std::read": [{ action: "approve" }] };
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

const reply = (output, toolCalls = []) => ({
  success: true,
  value: { output, toolCalls, model: "test", usage: USAGE, cost: COST },
});

function lastUserText(config) {
  const users = config.messages.filter((message) => message.role === "user");
  if (users.length === 0) return "";
  const content = users[users.length - 1].content;
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

// The test client. It answers by what the request holds, not by a call
// count, so the process that resumes needs no state from the one that
// paused.
function installClient(setClient, noteDir, projectDir) {
  setClient({
    async text(config) {
      const hasTools = (config.tools ?? []).length > 0;
      // The read's result, with the file's text in it: a rejected or a
      // failed read also leaves a tool message, and must not count.
      const readDone = config.messages.some(
        (message) => message.role === "tool" && JSON.stringify(message.content).includes("a note"),
      );
      const readTried = config.messages.some((message) => message.role === "tool");
      // A slash command of the project's, expanded: say what the model was sent.
      const said = lastUserText(config);
      if (said.includes("hello from the project")) return reply(`saw: ${said}`);
      // The session title is asked for with no tools.
      if (!hasTools) return reply("A title");
      // After the read, in the same turn: one edit, then the reply.
      const editDone = config.messages.some(
        (message) => message.role === "tool" && message.name === "edit",
      );
      if (readDone && !editDone) {
        return reply(null, [
          new ToolCall("call-2", "edit", {
            filename: "edited.txt",
            edits: [{ oldText: "before", newText: "after", replaceAll: false }],
            dir: projectDir,
          }),
        ]);
      }
      if (readDone) return reply("stub reply after the read");
      if (readTried) return reply("the read did not return the note");
      return reply(null, [new ToolCall("call-1", "read", { filename: "note.txt", dir: noteDir })]);
    },
    async *textStream(config) {
      const response = await this.text(config);
      yield { type: "done", result: response.value };
    },
    async embed() {
      throw new Error("Unexpected embedding request in the handoff test");
    },
  });
}

// The terminal front-end's modules. None may be on the saved stack.
const TERMINAL =
  /agency-agent\/(agent|lib\/(repl|capabilitiesUi|mcpMenu|header|transcript|args|policy|trace|runSession|resume|slashCommands\/[^.]+))\.agency$/;

/** What a front-end starts a session in `project` with. */
function startData({ project, id }) {
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

/** The first process: start a session and pause on the read's approval. */
async function startAndPause() {
  // The agent home is read when the modules load, so it is set first.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "session-handoff-"));
  process.env.AGENCY_AGENT_HOME = mkdtempSync(path.join(os.tmpdir(), "handoff-home-"));
  process.env.ANTHROPIC_API_KEY = "test-key";
  const project = mkdtempSync(path.join(os.tmpdir(), "handoff-project-"));
  // A command of the project's own. The first process never uses it: the
  // second has to find it, in a folder that is not the one it runs in.
  mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
  writeFileSync(path.join(project, ".claude", "commands", "hello.md"), "hello from the project");
  // The file the turn edits after it is resumed.
  writeFileSync(path.join(project, "edited.txt"), "before\n");
  // A folder outside the project, so the read is one no rule decides.
  const noteDir = mkdtempSync(path.join(os.tmpdir(), "handoff-notes-"));
  writeFileSync(path.join(noteDir, "note.txt"), "a note");

  const program = await import("agency-lang/agent-session");
  installClient(program.__setLLMClient, noteDir, project);

  const started = await program.main(startData({ project, id: "s1" }), { policy });
  const paused = await program.respondToInterrupts(
    started.data,
    [program.approve({ kind: "message", text: "read the note", notes: [], target: "" })],
    { invocation: { policy } },
  );
  const approval = paused.data;
  const modules = approval.flatMap((interrupt) =>
    Object.keys(interrupt.checkpoint?.moduleFingerprints ?? {}),
  );

  // A session started under `minimal`'s rules, saved at its first pause.
  const driver = await import("agency-lang/stdlib-lib/agentDriver/index.js");
  const savedPolicy = await driver.saveCarriedPolicy({
    home: process.env.AGENCY_AGENT_HOME,
    id: "s2",
    policy: minimalAutoApprovePolicy,
  });
  if (!savedPolicy.success) throw new Error(savedPolicy.error);
  const minimal = await program.main(startData({ project, id: "s2" }), { policy });

  // What a front-end saves: the interrupts, each with its checkpoint.
  const pauseFile = path.join(scratch, "pause.json");
  const minimalPauseFile = path.join(scratch, "minimal-pause.json");
  const resumedFile = path.join(scratch, "resumed.json");
  writeFileSync(pauseFile, JSON.stringify(approval));
  writeFileSync(minimalPauseFile, JSON.stringify(minimal.data));
  execFileSync(process.execPath, ["./test.js"], {
    stdio: "inherit",
    env: {
      ...process.env,
      RESUME: "1",
      NOTE_DIR: noteDir,
      PROJECT_DIR: project,
      PAUSE_FILE: pauseFile,
      MINIMAL_PAUSE_FILE: minimalPauseFile,
      RESUMED_FILE: resumedFile,
    },
  });
  const resumed = JSON.parse(readFileSync(resumedFile, "utf8"));

  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        pausedOn: approval.map((interrupt) => interrupt.effect),
        pauseHoldsTheCore: modules.some((id) => id.endsWith("agency-agent/core.agency")),
        pauseModulesHoldNoTerminalCode: !modules.some((id) => TERMINAL.test(id)),
        ...resumed,
      },
      null,
      2,
    ),
  );
}

/** The second process: load the program, never call `main`, and answer
 *  the approval the first process paused on. */
async function resume() {
  const program = await import("agency-lang/agent-session");
  installClient(program.__setLLMClient, process.env.NOTE_DIR, process.env.PROJECT_DIR);

  const pause = JSON.parse(readFileSync(process.env.PAUSE_FILE, "utf8"));
  const emitted = [];
  // The turn goes on to edit a file, which this policy approves. A handler
  // is not saved in a checkpoint: the core's edit-diff handler has to be
  // in place again in this process for the edit to be reported.
  const resumePolicy = { ...policy, "std::edit": [{ action: "approve" }] };
  const next = await program.respondToInterrupts(pause, [program.approve()], {
    metadata: { callbacks: { onEmit: (event) => void emitted.push(event) } },
    invocation: { policy: resumePolicy },
  });
  const paused = program.hasInterrupts(next.data);
  const data = paused ? next.data[0].data : null;
  // The project's own slash command, in a process that never ran `main`
  // and was not started in the project's folder.
  if (paused) {
    await program.respondToInterrupts(
      next.data,
      [program.approve({ kind: "message", text: "/hello", notes: [], target: "" })],
      {
        metadata: { callbacks: { onEmit: (event) => void emitted.push(event) } },
        invocation: { policy },
      },
    );
  }
  const replies = emitted.filter((event) => event.type === "session.reply").map((event) => event.text);
  const minimalSession = await resumeMinimalSession(program);

  writeFileSync(
    process.env.RESUMED_FILE,
    JSON.stringify({
      reply: replies.slice(0, 1),
      projectCommandAfterResume: replies[1] ?? "no reply",
      editDiffsAfterResume: emitted
        .filter((event) => event.type === "session.editDiff")
        .map((event) => event.filename),
      nextPauseEffect: paused ? next.data[0].effect : "the run ended",
      turnsAfterResume: data?.record?.turns,
      brainAfterResume: data?.record?.brain,
      mainModelAfterResume: data?.models?.main?.model,
      minimalSession,
    }),
  );
}

/** The session started under `minimal`'s rules, resumed through the driver
 *  by a front-end whose saved policy approves every read. The saved
 *  policy's approvals do not reach a session with a policy of its own, and
 *  `minimal` says nothing about reads, so the read the turn makes is asked
 *  about. */
async function resumeMinimalSession(program) {
  const driver = await import("agency-lang/stdlib-lib/agentDriver/index.js");
  const pause = JSON.parse(readFileSync(process.env.MINIMAL_PAUSE_FILE, "utf8"));
  const carried = await driver.readCarriedPolicy({ home: process.env.AGENCY_AGENT_HOME, id: "s2" });
  const policy = driver.sessionRunPolicy({ carried, saved: APPROVES_EVERY_READ, extra: null });
  if (!policy.success) {
    return { refused: policy.error };
  }
  const outcome = await driver.resumeRun({
    agent: program,
    callbacks: {},
    policy: policy.value,
    interrupts: pause,
    responses: [program.approve(driver.messageAnswer("read the note"))],
  });
  const step = outcome.result;
  return {
    carriesMinimal: JSON.stringify(carried.value) === JSON.stringify(minimalAutoApprovePolicy),
    step: step.success ? step.value.kind : step.error,
    pausedOn: step.success ? (step.value.interrupts ?? []).map((interrupt) => interrupt.effect) : [],
  };
}

if (process.env.RESUME) {
  await resume();
} else {
  await startAndPause();
}
process.exit(0);
